import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

import { createCommentApi, defaultCommentApiDeps } from "./comment-api.js";
import { createFileApi, defaultFileApiDeps } from "./file-api.js";
import { gpuWorkspaceCreateResponse, gpuWorkspaceDeleteResponse, gpuWorkspaceExecResponse, gpuWorkspaceStatusResponse } from "./gpu-workspace-api.js";
import { addIssueComment, editIssueComment, editReviewComment, editReviewSummary, fetchFileText, fetchPullRequestReviewData, replyToReviewComment, submitPullRequestReview } from "./github.js";
import { inputFromBody, readBody, recordFromBody, sendJson } from "./http.js";
import { logger } from "./logger.js";
import { createPiApi } from "./pi-api.js";
import { createPiJobRunner } from "./pi-jobs.js";
import { askPi, disposePiSession, disposePiSessions, piDiagnostics, prewarmPiSession, registerPiSessionCwd, setPiModel } from "./pi-session.js";
import { createPrApi, defaultPrApiDeps } from "./pr-api.js";
import { createReviewMemoryApi } from "./review-memory-api.js";
import { createReviewSubmitRouteApi, defaultReviewSubmitRouteApiDeps } from "./review-submit-route-api.js";
import { createSavedAnalysisApi } from "./saved-analysis-api.js";
import { currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, listAiReviews, listFocusScans, listRecentPullRequests, listReviewMemoryRecords, markPullRequestReviewed, removePullRequest, reviewMemoryStats, saveAiReview, saveFocusScan, saveReviewMemory, saveReviewProfile, setFileViewed, upsertPullRequest } from "./state.js";
import { cleanupPrWorktree, preparePrWorktree } from "./worktrees.js";

const DEFAULT_PORT = 43133;
const WEB_ROOT = resolve(process.cwd(), "dist-web");
const execFileAsync = promisify(execFile);

const piJobRunner = createPiJobRunner(askPi);
const commentApi = createCommentApi(defaultCommentApiDeps({ addIssueComment, editIssueComment, editReviewComment, editReviewSummary, replyToReviewComment }));
const fileApi = createFileApi(defaultFileApiDeps(fetchFileText, setFileViewed, async (url) => {
  await execFileAsync("open", [url]);
}));
const piApi = createPiApi({ askPi, piDiagnostics, piJobRunner, setPiModel });
const prApi = createPrApi(defaultPrApiDeps({ cleanupPrWorktree, disposePiSession, fetchPullRequestReviewData, listAiReviews, listFocusScans, preparePrWorktree, prewarmPiSession, registerPiSessionCwd, removePullRequest, upsertPullRequest }));
const reviewMemoryApi = createReviewMemoryApi({ askPi, currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, listReviewMemoryRecords, reviewMemoryStats, saveReviewMemory, saveReviewProfile });
const reviewSubmitRouteApi = createReviewSubmitRouteApi(defaultReviewSubmitRouteApiDeps({ fetchPullRequestReviewData, markPullRequestReviewed, saveReviewMemory, submitPullRequestReview }));
const savedAnalysisApi = createSavedAnalysisApi({ saveAiReview, saveFocusScan });

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
    sendJson(res, 200, await reviewMemoryApi.status(url.searchParams.get("limit")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-memory/distill") {
    logger.info("api", "review memory distillation requested");
    sendJson(res, 200, await reviewMemoryApi.distill());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/review-memory/capture") {
    const payload = recordFromBody(await readBody(req));
    const response = await reviewMemoryApi.capture(payload);
    logger.info("api", "review memory captured", { prKey: payload.prKey, comments: response.memory.comments.length, event: payload.event });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/parse") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "parse PR input", { input });
    sendJson(res, 200, prApi.parse(input));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/cleanup") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "cleanup PR requested", { input });
    const response = await prApi.cleanup(input);
    logger.info("api", "cleanup PR complete", { prKey: response.prKey, worktreeDir: response.worktreeDir });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/activity") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "refresh PR activity requested", { input });
    const response = await prApi.activity(input);
    logger.info("api", "refresh PR activity complete", { key: response.pr.key, existingCommentCount: response.pr.existingCommentCount });
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file/viewed") {
    const payload = recordFromBody(await readBody(req));
    logger.info("api", "set file viewed", payload);
    sendJson(res, 200, await fileApi.viewed(payload));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file/text") {
    sendJson(res, 200, await fileApi.text(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/file/open") {
    sendJson(res, 200, await fileApi.open(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ask/stream") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    await streamAskPi(res, payload.prKey, payload.prompt, typeof payload.purpose === "string" ? payload.purpose : undefined);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ask") {
    sendJson(res, 200, await piApi.ask(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && (url.pathname === "/api/pi/review/status" || url.pathname === "/api/pi/focus-review/status")) {
    sendJson(res, 200, await piApi.jobStatus(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/review") {
    const payload = recordFromBody(await readBody(req));
    const response = await piApi.startReviewJob(payload, "main-review");
    logger.info("api", "main review job started", { prKey: payload.prKey, jobId: response.job.id });
    sendJson(res, 202, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/focus-review") {
    const payload = recordFromBody(await readBody(req));
    const response = await piApi.startReviewJob(payload, "focus-review");
    logger.info("api", "focus review job started", { prKey: payload.prKey, jobId: response.job.id });
    sendJson(res, 202, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/focus-scan/save") {
    sendJson(res, 200, await savedAnalysisApi.saveFocusScan(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ai-review/save") {
    sendJson(res, 200, await savedAnalysisApi.saveAiReview(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/diagnostics") {
    sendJson(res, 200, await piApi.diagnostics(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/model") {
    sendJson(res, 200, await piApi.setModel(recordFromBody(await readBody(req))));
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
    logger.info("api", "submit review requested", { prUrl: payload.prUrl, comments: Array.isArray(payload.comments) ? payload.comments.length : 0, event: payload.event });
    sendJson(res, 200, await reviewSubmitRouteApi.submit(payload));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/comment/reply") {
    sendJson(res, 200, await commentApi.reply(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/comment/edit") {
    sendJson(res, 200, await commentApi.edit(recordFromBody(await readBody(req))));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pr/open") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "open PR requested", { input });
    const response = await prApi.open(input);
    logger.info("api", "open PR complete", { key: response.pr.key, filesChanged: response.pr.filesChanged, existingCommentCount: response.pr.existingCommentCount, worktreeDir: response.worktreeDir });
    sendJson(res, 200, response);
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
