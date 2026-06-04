import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { gpuWorkspaceCreateResponse, gpuWorkspaceDeleteResponse, gpuWorkspaceExecResponse, gpuWorkspaceStatusResponse } from "./gpu-workspace-api.js";
import { addIssueComment, editIssueComment, editReviewComment, editReviewSummary, fetchFileText, fetchPullRequestReviewData, replyToReviewComment, submitPullRequestReview } from "./github.js";
import { inputFromBody, prKeyForRef, readBody, recordFromBody, refFromBody, sendJson, viewedPayloadFromBody } from "./http.js";
import { logger } from "./logger.js";
import { createPiJobRunner } from "./pi-jobs.js";
import { askPi, disposePiSession, disposePiSessions, piDiagnostics, prewarmPiSession, registerPiSessionCwd, setPiModel } from "./pi-session.js";
import { parsePullRequestRef } from "./pr.js";
import { githubReviewComments, reviewMemoryChangeSet, reviewMemoryComments, reviewSubmitCommentsFromPayload, reviewSubmitFailureMessage } from "./review-submit-api.js";
import { currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, listAiReviews, listFocusScans, listRecentPullRequests, listReviewMemoryRecords, markPullRequestReviewed, removePullRequest, reviewMemoryStats, saveAiReview, saveFocusScan, saveReviewMemory, saveReviewProfile, setFileViewed, upsertPullRequest } from "./state.js";
import type { AiReviewMessageRecord, FocusAreaReviewState, PullRequestReviewResponse, ReviewMemoryChangeSet, StoredPullRequest } from "./types.js";
import { cleanupPrWorktree, preparePrWorktree, worktreeDirForRef } from "./worktrees.js";

const DEFAULT_PORT = 43133;
const WEB_ROOT = resolve(process.cwd(), "dist-web");
const execFileAsync = promisify(execFile);

const piJobRunner = createPiJobRunner(askPi);

async function hydrateReviewResponse(data: Awaited<ReturnType<typeof fetchPullRequestReviewData>>, pr: StoredPullRequest, extra: Partial<Pick<PullRequestReviewResponse, "worktreeDir">> = {}): Promise<PullRequestReviewResponse> {
  const [focusScans, aiReviews] = await Promise.all([listFocusScans(pr.key), listAiReviews(pr.key)]);
  return { ...data, pr, focusScan: focusScans[0] ?? null, focusScans, aiReview: aiReviews[0] ?? null, aiReviews, ...extra };
}

async function distillReviewMemory(): Promise<string> {
  const existingProfile = await currentReviewProfile();
  const source = await currentReviewMemoryDistillationSource();
  const prompt = `Distill Driss's code-review preferences from raw submitted review comments into an actionable reviewer profile.

Return only markdown with these sections:
# Driss review profile
## What to flag
## What to usually ignore
## Severity calibration
## Comment style
## Review prompt rules

Make the profile compact and directive. Prefer durable patterns over one-off specifics. Include actionable rules a future reviewer can follow. Do not include raw examples verbatim except short representative phrases when needed.

Existing profile:
${existingProfile?.text ?? "No existing profile."}

Raw review evidence:
${source}`;
  const answer = await askPi("review-memory", prompt, "review-memory-distill");
  return (await saveReviewProfile(answer)).text;
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

  if (req.method === "GET" && url.pathname === "/api/review-memory") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    sendJson(res, 200, { prompt: await currentReviewMemoryPrompt(), profile: await currentReviewProfile(), records: await listReviewMemoryRecords(Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50), stats: await reviewMemoryStats() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-memory/distill") {
    logger.info("api", "review memory distillation requested");
    sendJson(res, 200, { profile: await distillReviewMemory() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-memory/capture") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string") throw new Error("Expected prKey and headSha");
    if (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") throw new Error("Expected review event");
    const memory = await saveReviewMemory({ prKey: payload.prKey, headSha: payload.headSha, event: payload.event, body: typeof payload.body === "string" ? payload.body.trim() : "", comments: reviewMemoryComments(reviewSubmitCommentsFromPayload(payload.comments)), changeSet: typeof payload.changeSet === "object" && payload.changeSet != null && !Array.isArray(payload.changeSet) ? payload.changeSet as ReviewMemoryChangeSet : undefined });
    logger.info("api", "review memory captured", { prKey: payload.prKey, comments: memory.comments.length, event: payload.event });
    sendJson(res, 200, { memory });
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
    sendJson(res, 200, await hydrateReviewResponse(data, pr));
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
    const job = piJobRunner.getJob(payload.jobId);
    if (job == null) throw new Error(`Unknown review job ${payload.jobId}`);
    sendJson(res, 200, { job });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/review") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    const job = piJobRunner.startJob(payload.prKey, payload.prompt, "main-review");
    logger.info("api", "main review job started", { prKey: payload.prKey, jobId: job.id });
    sendJson(res, 202, { job });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/focus-review") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    const job = piJobRunner.startJob(payload.prKey, payload.prompt, "focus-review");
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

  if (req.method === "POST" && url.pathname === "/api/ai-review/save") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || typeof payload.answer !== "string") throw new Error("Expected AI review payload");
    sendJson(res, 200, { review: await saveAiReview({ id: typeof payload.id === "string" ? payload.id : undefined, prKey: payload.prKey, headSha: payload.headSha, answer: payload.answer, messages: Array.isArray(payload.messages) ? payload.messages as AiReviewMessageRecord[] : undefined }) });
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

  if (req.method === "POST" && url.pathname === "/api/gpu/workspaces/status") {
    sendJson(res, 200, await gpuWorkspaceStatusResponse(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gpu/workspaces") {
    const payload = recordFromBody(await readBody(req));
    logger.info("api", "gpu workspace requested", { prUrl: payload.prUrl, gpuType: payload.gpuType });
    const response = await gpuWorkspaceCreateResponse(payload);
    const workspace = response.workspace as { gpuType?: unknown; id?: unknown; uri?: unknown } | undefined;
    logger.info("api", "gpu workspace ready", { gpuType: workspace?.gpuType, id: workspace?.id, uri: workspace?.uri, reused: response.reused });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gpu/workspaces/delete") {
    const payload = recordFromBody(await readBody(req));
    logger.info("api", "gpu workspace delete requested", { id: payload.id });
    const response = await gpuWorkspaceDeleteResponse(payload);
    const result = response.result as { id?: unknown } | undefined;
    logger.info("api", "gpu workspace deleted", { id: result?.id });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gpu/workspaces/exec") {
    const payload = recordFromBody(await readBody(req));
    logger.info("api", "gpu workspace exec requested", { id: payload.id, command: payload.command });
    const response = await gpuWorkspaceExecResponse(payload);
    const result = response.result as { id?: unknown; exitCode?: unknown; signal?: unknown } | undefined;
    logger.info("api", "gpu workspace exec complete", { id: result?.id, exitCode: result?.exitCode, signal: result?.signal });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review/submit") {
    const payload = recordFromBody(await readBody(req));
    const ref = refFromBody(payload);
    if (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") throw new Error("Expected review event");
    const comments = reviewSubmitCommentsFromPayload(payload.comments);
    logger.info("api", "submit review requested", { ref, comments: comments.length, event: payload.event });
    let result: unknown;
    try {
      result = await submitPullRequestReview(ref, { event: payload.event, body: payload.body, comments: githubReviewComments(comments) });
    } catch (error) {
      throw new Error(reviewSubmitFailureMessage(error, comments));
    }
    const prKey = prKeyForRef(ref);
    const memoryComments = reviewMemoryComments(comments);
    const reviewData = await fetchPullRequestReviewData(ref);
    await saveReviewMemory({ prKey, headSha: typeof payload.headSha === "string" ? payload.headSha : "", event: payload.event, body: typeof payload.body === "string" ? payload.body.trim() : "", comments: memoryComments, changeSet: reviewMemoryChangeSet(reviewData, memoryComments) });
    const reviewedPr = await markPullRequestReviewed(prKey, typeof payload.headSha === "string" ? payload.headSha : "", payload.event);
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
    sendJson(res, 200, await hydrateReviewResponse(data, pr, { worktreeDir }));
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
