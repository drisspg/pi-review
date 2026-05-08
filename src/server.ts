import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

import { addIssueComment, fetchFileText, fetchPullRequestReviewData, replyToReviewComment, submitPullRequestReview } from "./github.js";
import { inputFromBody, prKeyForRef, readBody, recordFromBody, refFromBody, sendJson, viewedPayloadFromBody } from "./http.js";
import { logger } from "./logger.js";
import { askPi, disposePiSession, disposePiSessions, piDiagnostics, prewarmPiSession, registerPiSessionCwd, setPiModel } from "./pi-session.js";
import { parsePullRequestRef } from "./pr.js";
import { listRecentPullRequests, removePullRequest, setFileViewed, upsertPullRequest } from "./state.js";
import { cleanupPrWorktree, preparePrWorktree } from "./worktrees.js";

const DEFAULT_PORT = 43133;
const WEB_ROOT = resolve(process.cwd(), "dist-web");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function sendStatic(res: ServerResponse, pathname: string): Promise<void> {
  const candidate = normalize(pathname).replace(/^([/\\])+/, "");
  const filePath = resolve(join(WEB_ROOT, candidate.length > 0 ? candidate : "index.html"));
  const safePath = filePath.startsWith(WEB_ROOT) ? filePath : join(WEB_ROOT, "index.html");
  const finalPath = pathname.startsWith("/assets/") ? safePath : join(WEB_ROOT, "index.html");
  const data = await readFile(finalPath);
  res.writeHead(200, { "content-type": contentTypes[extname(finalPath)] ?? "application/octet-stream" });
  res.end(data);
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
    sendJson(res, 200, { ...data, pr });
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

  if (req.method === "POST" && url.pathname === "/api/ask") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    sendJson(res, 200, { answer: await askPi(payload.prKey, payload.prompt) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pi/focus-review") {
    const payload = recordFromBody(await readBody(req));
    if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
    sendJson(res, 200, { answer: await askPi(payload.prKey, payload.prompt, "focus-review") });
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
    logger.info("api", "submit review requested", { ref, comments: Array.isArray(payload.comments) ? payload.comments.length : 0, event: payload.event });
    sendJson(res, 200, { result: await submitPullRequestReview(ref, { event: payload.event, body: payload.body, comments: payload.comments }) });
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

  if (req.method === "POST" && url.pathname === "/api/pr/open") {
    const input = inputFromBody(await readBody(req));
    logger.info("api", "open PR requested", { input });
    const ref = parsePullRequestRef(input);
    const data = await fetchPullRequestReviewData(ref);
    const pr = await upsertPullRequest(data.pr);
    const worktreeDir = await preparePrWorktree(ref, data.raw.base.repo.clone_url, data.pr.headSha);
    await registerPiSessionCwd(pr.key, worktreeDir);
    prewarmPiSession(pr.key);
    logger.info("api", "open PR complete", { key: pr.key, filesChanged: pr.filesChanged, existingCommentCount: pr.existingCommentCount, worktreeDir });
    sendJson(res, 200, { ...data, pr, worktreeDir });
    return;
  }

  if (req.method === "GET") {
    await sendStatic(res, url.pathname);
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
