import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createAskStreamApi } from "./ask-stream-api.js";
import { createCommentApi, defaultCommentApiDeps } from "./comment-api.js";
import { createDraftReviewApi } from "./draft-review-api.js";
import { createFileApi, defaultFileApiDeps } from "./file-api.js";
import { createGitHubDraftReviewApi, defaultGitHubDraftReviewApiDeps } from "./github-draft-review-api.js";
import { gpuWorkspaceCreateResponse, gpuWorkspaceDeleteResponse, gpuWorkspaceExecResponse, gpuWorkspaceStatusResponse } from "./gpu-workspace-api.js";
import { addIssueComment, addPendingPullRequestReviewThread, createPendingPullRequestReview, editIssueComment, editReviewComment, editReviewSummary, fetchFileText, fetchPendingPullRequestReview, fetchPullRequestReviewData, replyToReviewComment, submitPullRequestReview } from "./github.js";
import { logger } from "./logger.js";
import { createPiApi } from "./pi-api.js";
import { createPiJobRunner } from "./pi-jobs.js";
import { createPiTerminalApi } from "./pi-terminal-api.js";
import { createPiTerminalDraftApi } from "./pi-terminal-draft-api.js";
import { createPiTerminalManager } from "./pi-terminal.js";
import { attachPiTerminalWebSocketServer } from "./pi-terminal-websocket.js";
import { askPi, disposePiSession, disposePiSessions, piActivity, piDiagnostics, piSessionCwd, piSessionReviewContext, prewarmPiSession, registerPiSessionContext, setPiModel } from "./pi-session.js";
import { createPrApi, defaultPrApiDeps } from "./pr-api.js";
import { createReviewArchiveApi, defaultReviewArchiveApiDeps } from "./review-archive-api.js";
import { createReviewMemoryApi } from "./review-memory-api.js";
import { createReviewPromptApi } from "./review-prompt-api.js";
import { createReviewSubmitRouteApi, defaultReviewSubmitRouteApiDeps } from "./review-submit-route-api.js";
import { createSavedAnalysisApi } from "./saved-analysis-api.js";
import { createServerRoute, createRequestListener } from "./server-router.js";
import { createShellApi } from "./shell-api.js";
import { appendDraftReviewComment, clearDraftReview, currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, getDraftReview, listAiReviews, listFocusScans, listGuideReviews, listRecentPullRequests, listReviewMemoryRecords, markPullRequestReviewed, removePullRequest, reviewMemoryStats, saveAiReview, saveDraftReview, saveFocusScan, saveGuideReview, saveReviewMemory, saveReviewProfile, setFileViewed, upsertPullRequest } from "./state.js";
import { cleanupPrWorktree, preparePrWorktree } from "./worktrees.js";

const DEFAULT_PORT = 43133;
const WEB_ROOT = resolve(process.cwd(), "dist-web");
const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.env.PI_PR_REVIEW_PORT ?? "", 10) || DEFAULT_PORT;
const compiledTerminalExtension = fileURLToPath(new URL("./pi-review-terminal-extension.js", import.meta.url));
const sourceTerminalExtension = fileURLToPath(new URL("./pi-review-terminal-extension.ts", import.meta.url));

const piJobRunner = createPiJobRunner(askPi);
const piTerminalManager = createPiTerminalManager({
  apiUrl: `http://127.0.0.1:${port}`,
  cwdForPr: piSessionCwd,
  extensionPath: existsSync(compiledTerminalExtension) ? compiledTerminalExtension : sourceTerminalExtension,
  logger,
});
const askStreamApi = createAskStreamApi({ askPi, logger });
const commentApi = createCommentApi(defaultCommentApiDeps({ addIssueComment, editIssueComment, editReviewComment, editReviewSummary, replyToReviewComment }));
const draftReviewApi = createDraftReviewApi({ clearDraftReview, getDraftReview, now: () => new Date().toISOString(), saveDraftReview });
const fileApi = createFileApi(defaultFileApiDeps(fetchFileText, setFileViewed, async (url) => {
  await execFileAsync("open", [url]);
}));
const githubDraftReviewApi = createGitHubDraftReviewApi(defaultGitHubDraftReviewApiDeps({ addPendingPullRequestReviewThread, createPendingPullRequestReview, fetchPendingPullRequestReview }));
const piApi = createPiApi({ askPi, piActivity, piDiagnostics, piJobRunner, setPiModel });
const piTerminalApi = createPiTerminalApi({ deleteSession: piTerminalManager.deleteSession });
const piTerminalDraftApi = createPiTerminalDraftApi({ appendDraftReviewComment, contextForPr: piSessionReviewContext, notifyDraftReview: piTerminalManager.broadcastDraftReview });
const prApi = createPrApi(defaultPrApiDeps({
  cleanupPrWorktree,
  disposePiSession: async (prKey) => {
    await Promise.all([disposePiSession(prKey), piTerminalManager.disposePr(prKey)]);
  },
  fetchPullRequestReviewData,
  getDraftReview,
  listAiReviews,
  listFocusScans,
  listGuideReviews,
  preparePrWorktree,
  prewarmPiSession,
  registerPiSessionContext,
  removePullRequest,
  upsertPullRequest,
}));
const reviewArchiveApi = createReviewArchiveApi(defaultReviewArchiveApiDeps({ clearDraftReview, fetchPullRequestReviewData, saveReviewMemory }));
const reviewMemoryApi = createReviewMemoryApi({ askPi, currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, listReviewMemoryRecords, reviewMemoryStats, saveReviewMemory, saveReviewProfile });
const reviewPromptApi = createReviewPromptApi({ currentReviewMemoryPrompt });
const reviewSubmitRouteApi = createReviewSubmitRouteApi(defaultReviewSubmitRouteApiDeps({ clearDraftReview, fetchPullRequestReviewData, markPullRequestReviewed, saveReviewMemory, submitPullRequestReview }));
const savedAnalysisApi = createSavedAnalysisApi({ saveAiReview, saveFocusScan, saveGuideReview });
const shellApi = createShellApi({ listRecentPullRequests, logEntries: logger.entries });

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

const route = createServerRoute({
  askStreamApi,
  commentApi,
  draftReviewApi,
  fileApi,
  githubDraftReviewApi,
  gpuWorkspaceCreateResponse,
  gpuWorkspaceDeleteResponse,
  gpuWorkspaceExecResponse,
  gpuWorkspaceStatusResponse,
  logger,
  piApi,
  piTerminalApi,
  piTerminalDraftApi,
  prApi,
  reviewArchiveApi,
  reviewMemoryApi,
  reviewPromptApi,
  reviewSubmitRouteApi,
  savedAnalysisApi,
  sendStatic,
  shellApi,
});

const server = createServer(createRequestListener(route, logger));
const detachPiTerminalWebSocketServer = attachPiTerminalWebSocketServer(server, piTerminalManager, logger);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server", "shutdown", { signal });
  detachPiTerminalWebSocketServer();
  server.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    piTerminalManager.dispose(),
    disposePiSessions(),
  ]);
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(port, "127.0.0.1", () => {
  logger.info("server", "listening", { url: `http://127.0.0.1:${port}`, webRoot: WEB_ROOT });
});
