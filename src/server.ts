import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { addIssueComment, editIssueComment, editReviewComment, editReviewSummary, fetchFileText, fetchPullRequestReviewData, replyToReviewComment, submitPullRequestReview } from "./github.js";
import { inputFromBody, prKeyForRef, readBody, recordFromBody, refFromBody, sendJson, viewedPayloadFromBody } from "./http.js";
import { logger } from "./logger.js";
import { askPi, disposePiSession, disposePiSessions, piDiagnostics, prewarmPiSession, registerPiSessionCwd, setPiModel } from "./pi-session.js";
import { parsePullRequestRef } from "./pr.js";
import { latestFocusScan, listRecentPullRequests, markPullRequestReviewed, removePullRequest, saveFocusScan, setFileViewed, upsertPullRequest } from "./state.js";
import type { FocusAreaReviewState } from "./types.js";
import { cleanupPrWorktree, preparePrWorktree, worktreeDirForRef } from "./worktrees.js";

const DEFAULT_PORT = 43133;
const WEB_ROOT = resolve(process.cwd(), "dist-web");
const execFileAsync = promisify(execFile);

type PiReviewJob = {
  id: string;
  prKey: string;
  status: "running" | "complete" | "failed";
  answer?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

const piReviewJobs = new Map<string, PiReviewJob>();

function startPiReviewJob(prKey: string, prompt: string, sessionKind?: string): PiReviewJob {
  const job: PiReviewJob = { id: randomUUID(), prKey, status: "running", startedAt: new Date().toISOString() };
  piReviewJobs.set(job.id, job);
  void askPi(prKey, prompt, sessionKind).then((answer) => {
    piReviewJobs.set(job.id, { ...job, status: "complete", answer, finishedAt: new Date().toISOString() });
  }).catch((error: unknown) => {
    piReviewJobs.set(job.id, { ...job, status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
  });
  return job;
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamAskPi(res: ServerResponse, prKey: string, prompt: string, purpose?: string): Promise<void> {
  res.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  logger.info("pi", "stream prompt start", { prKey, purpose: purpose ?? "chat", chars: prompt.length });
  try {
    const answer = await askPi(prKey, prompt, purpose, (delta) => sse(res, "delta", { delta }));
    sse(res, "done", { answer });
    logger.info("pi", "stream prompt done", { prKey, purpose: purpose ?? "chat", answerChars: answer.length });
  } catch (error) {
    logger.error("pi", "stream prompt failed", { prKey, purpose: purpose ?? "chat", error: error instanceof Error ? error.message : String(error) });
    sse(res, "error", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function sendStatic(res: ServerResponse, pathname: string, head = false): Promise<void> {
  const staticPathname = pathname === "/favicon.ico" ? "/favicon.svg" : pathname;
  const candidate = normalize(staticPathname).replace(/^([/\\])+/, "");
  const filePath = resolve(join(WEB_ROOT, candidate.length > 0 ? candidate : "index.html"));
  const safePath = filePath.startsWith(WEB_ROOT) ? filePath : join(WEB_ROOT, "index.html");
  const finalPath = staticPathname.startsWith("/assets/") || staticPathname === "/favicon.svg" ? safePath : join(WEB_ROOT, "index.html");
  const data = await readFile(finalPath);
  res.writeHead(200, { "content-type": contentTypes[extname(finalPath)] ?? "application/octet-stream" });
  res.end(head ? undefined : data);
}

async function openInEditor(prUrl: string, path: string, line?: number): Promise<string> {
  const worktreeDir = worktreeDirForRef(parsePullRequestRef(prUrl));
  const filePath = resolve(worktreeDir, path);
  if (filePath !== worktreeDir && !filePath.startsWith(`${worktreeDir}${sep}`)) throw new Error("File path escapes PR worktree");
  const target = `${filePath}:${line ?? 1}:1`;
  const url = `vscode://file${encodeURI(target)}`;
  await execFileAsync("open", [url]);
  return target;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, null);
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/prs") {
    sendJson(res, 200, { prs: await listRecentPullRequests() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(res, 200, { logs: logger.entries() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/parse") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "parse PR input", { input });
    sendJson(res, 200, { ref: parsePullRequestRef(input) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/cleanup") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "cleanup PR requested", { input });
    const ref = parsePullRequestRef(input);
    const prKey = prKeyForRef(ref);
    await disposePiSession(prKey);
    const worktreeDir = await cleanupPrWorktree(ref);
    await removePullRequest(prKey);
    logger.info("api", "cleanup PR complete", { prKey, worktreeDir });
    sendJson(res, 200, { ok: true, prKey, worktreeDir });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/activity") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "refresh PR activity requested", { input });
    const ref = parsePullRequestRef(input);
    const data = await fetchPullRequestReviewData(ref);
    const pr = await upsertPullRequest(data.pr);
    logger.info("api", "refresh PR activity complete", { key: pr.key, existingCommentCount: pr.existingCommentCount });
    sendJson(res, 200, { ...data, pr, focusScan: await latestFocusScan(pr.key) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file/viewed") {
    const payload = viewedPayloadFromBody(await readBody(req));
    logger.info("api", "set file viewed", payload);
    sendJson(res, 200, { fileReview: await setFileViewed({ ...payload, updatedAt: new Date().toISOString() }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file/text") {
    const payload = recordFromBody(await readBody(req));
    const ref = refFromBody(payload);
    if (typeof payload.path !== "string" || typeof payload.sha !== "string") throw new Error("Expected path and sha");
    sendJson(res, 200, { text: await fetchFileText(ref, payload.path, payload.sha) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file/open") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prUrl !== "string" || typeof payload.path !== "string") throw new Error("Expected prUrl and path");
    sendJson(res, 200, { target: await openInEditor(payload.prUrl, payload.path, typeof payload.line === "number" ? payload.line : undefined) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ask/stream") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    await streamAskPi(res, payload.prKey, payload.prompt, typeof payload.purpose === "string" ? payload.purpose : undefined);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    sendJson(res, 200, { answer: await askPi(payload.prKey, payload.prompt, typeof payload.purpose === "string" ? payload.purpose : undefined) });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/pi/review/status" || url.pathname === "/api/pi/focus-review/status")) {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.jobId !== "string") throw new Error("Expected jobId");
    const job = piReviewJobs.get(payload.jobId);
    if (job == null) throw new Error(`Unknown review job ${payload.jobId}`);
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/review") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    const job = startPiReviewJob(payload.prKey, payload.prompt, "main-review");
    logger.info("api", "main review job started", { prKey: payload.prKey, jobId: job.id });
    sendJson(res, 202, { job });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/focus-review") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    const job = startPiReviewJob(payload.prKey, payload.prompt, "focus-review");
    logger.info("api", "focus review job started", { prKey: payload.prKey, jobId: job.id });
    sendJson(res, 202, { job });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/focus-scan/save") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || typeof payload.answer !== "string" || typeof payload.areaStates !== "object" || payload.areaStates == null || Array.isArray(payload.areaStates)) throw new Error("Expected focus scan payload");
    sendJson(res, 200, { scan: await saveFocusScan({ id: typeof payload.id === "string" ? payload.id : undefined, prKey: payload.prKey, headSha: payload.headSha, answer: payload.answer, areaStates: payload.areaStates as Record<string, FocusAreaReviewState> }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/diagnostics") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string") throw new Error("Expected prKey");
    sendJson(res, 200, { diagnostics: await piDiagnostics(payload.prKey) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/model") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.provider !== "string" || typeof payload.modelId !== "string") throw new Error("Expected prKey, provider, and modelId");
    sendJson(res, 200, { diagnostics: await setPiModel(payload.prKey, payload.provider, payload.modelId, typeof payload.thinkingLevel === "string" ? payload.thinkingLevel : undefined) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review/submit") {
    const payload = recordFromBody(await readBody(req));
    const ref = refFromBody(payload);
    if (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") throw new Error("Expected review event");
    logger.info("api", "submit review requested", { ref, comments: Array.isArray(payload.comments) ? payload.comments.length : 0, event: payload.event });
    const result = await submitPullRequestReview(ref, { event: payload.event, body: payload.body, comments: payload.comments });
    const reviewedPr = await markPullRequestReviewed(prKeyForRef(ref), typeof payload.headSha === "string" ? payload.headSha : "", payload.event);
    sendJson(res, 200, { result, pr: reviewedPr });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/comment/reply") {
    const payload = recordFromBody(await readBody(req));
    const ref = refFromBody(payload);
    if (typeof payload.body !== "string" || payload.body.trim().length === 0) throw new Error("Expected non-empty body");
    if (payload.kind === "issue") {
      sendJson(res, 200, { result: await addIssueComment(ref, payload.body.trim()) });
      return;
    }
    if (typeof payload.commentId !== "number") throw new Error("Expected commentId");
    sendJson(res, 200, { result: await replyToReviewComment(ref, payload.commentId, payload.body.trim()) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/comment/edit") {
    const payload = recordFromBody(await readBody(req));
    const ref = refFromBody(payload);
    if (typeof payload.commentId !== "number") throw new Error("Expected commentId");
    if (typeof payload.body !== "string" || payload.body.trim().length === 0) throw new Error("Expected non-empty body");
    if (payload.kind === "issue") {
      sendJson(res, 200, { result: await editIssueComment(ref, payload.commentId, payload.body.trim()) });
      return;
    }
    if (payload.kind === "review-summary") {
      sendJson(res, 200, { result: await editReviewSummary(ref, payload.commentId, payload.body.trim()) });
      return;
    }
    if (payload.kind !== "review") throw new Error("Expected comment kind");
    sendJson(res, 200, { result: await editReviewComment(ref, payload.commentId, payload.body.trim()) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/open") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "open PR requested", { input });
    const ref = parsePullRequestRef(input);
    const data = await fetchPullRequestReviewData(ref);
    const pr = await upsertPullRequest(data.pr);
    const worktreeDir = await preparePrWorktree(ref, data.raw.base.repo.clone_url, data.pr.headSha);
    await registerPiSessionCwd(pr.key, worktreeDir);
    prewarmPiSession(pr.key, ["chat", "inline-chat", "focus-chat"]);
    logger.info("api", "open PR complete", { key: pr.key, filesChanged: pr.filesChanged, existingCommentCount: pr.existingCommentCount, worktreeDir });
    sendJson(res, 200, { ...data, pr, focusScan: await latestFocusScan(pr.key), worktreeDir });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await sendStatic(res, url.pathname, req.method === "HEAD");
    return;
  }

  sendJson(res, 404, { error: `No route for ${req.method ?? "GET"} ${url.pathname}` });
}

const server = createServer((req, res) => {
  const startedAt = performance.now();
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const shouldLogRequest = method !== "GET";
  if (shouldLogRequest) logger.info("http", "request start", { method, url });
  res.on("finish", () => {
    if (shouldLogRequest) logger.info("http", "request finish", { method, url, status: res.statusCode, ms: Math.round(performance.now() - startedAt) });
  });
  route(req, res).catch((error: unknown) => {
    logger.error("http", "request failed", { method, url, error: error instanceof Error ? error.message : String(error) });
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server", "shutdown", { signal });
  server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await disposePiSessions();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const port = Number.parseInt(process.env.PI_PR_REVIEW_PORT ?? "", 10) || DEFAULT_PORT;
server.listen(port, "127.0.0.1", () => {
  logger.info("server", "listening", { url: `http://127.0.0.1:${port}`, webRoot: WEB_ROOT });
});
