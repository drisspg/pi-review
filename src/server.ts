import { execFile, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createActivityApi, resolveActivityLedgerPath } from "./activity-api.js";
import { createAskStreamApi } from "./ask-stream-api.js";
import { createBlameApi } from "./blame-api.js";
import { createCommentApi, defaultCommentApiDeps } from "./comment-api.js";
import { ownServerCheckoutCache } from "./checkout-cache.js";
import { checkoutCacheRoot } from "./storage-paths.js";
import { createDraftReviewApi } from "./draft-review-api.js";
import { createFileApi, defaultFileApiDeps } from "./file-api.js";
import { createGitHubDraftReviewApi, defaultGitHubDraftReviewApiDeps } from "./github-draft-review-api.js";
import { gpuWorkspaceCreateResponse, gpuWorkspaceDeleteResponse, gpuWorkspaceExecResponse, gpuWorkspaceStatusResponse } from "./gpu-workspace-api.js";
import { createInboxApi, type InboxSnapshot } from "./inbox-api.js";
import { createPreReviewAssessor, formatPreReviewEvidence } from "./pre-review-assessor.js";
import { createPreReviewChat } from "./pre-review-chat.js";
import { piLaunch, piModelArgs, piThinkingLevel, readPiReviewLocalConfig } from "./pi-launch.js";
import { createPytorchWorkflowApi, PYTORCH_REPO, type PytorchStore } from "./pytorch-workflow-api.js";
import { createGitInterdiff } from "./interdiff-git.js";
import { createMissingPatchRecovery } from "./missing-patches.js";
import { addIssueComment, addPendingPullRequestReviewThread, compareCommits, createPendingPullRequestReview, defaultGitHubClient, editIssueComment, editReviewComment, editReviewSummary, fetchCommitChecks, fetchFileText, fetchLatestActivity, fetchNotifications, fetchPendingPullRequestReview, fetchPullRequestReviewData, fetchSubjectSnapshots, fetchViewerLogin, fetchViewerPullRequests, markNotificationDone, replyToReviewComment, setReviewThreadResolved, submitPullRequestReview, unsubscribeNotification } from "./github.js";
import { logger } from "./logger.js";
import { parsePullRequestRef, prKey } from "./pr.js";
import { createPiApi } from "./pi-api.js";
import { createAnalysisApi } from "./analysis-api.js";
import { createPiTerminalApi } from "./pi-terminal-api.js";
import { createPiTerminalDraftApi } from "./pi-terminal-draft-api.js";
import { createPiTerminalManager } from "./pi-terminal.js";
import { attachPiTerminalWebSocketServer } from "./pi-terminal-websocket.js";
import { askPi, disposePiSession, disposePiSessions, piActivity, piDiagnostics, piSessionCwd, piSessionReviewContext, piRunModel, prewarmPiSession, registerPiSessionContext, setPiModel } from "./pi-session.js";
import { createPrApi, defaultPrApiDeps } from "./pr-api.js";
import { createReviewArchiveApi, defaultReviewArchiveApiDeps } from "./review-archive-api.js";
import { createReviewMemoryApi } from "./review-memory-api.js";
import { createReviewPromptApi } from "./review-prompt-api.js";
import { createReviewSubmitRouteApi, defaultReviewSubmitRouteApiDeps } from "./review-submit-route-api.js";
import { createSavedAnalysisApi } from "./saved-analysis-api.js";
import { createServerRoute, createRequestListener } from "./server-router.js";
import { createShutdownRequest } from "./server-shutdown.js";
import { createShellApi } from "./shell-api.js";
import { withTtlCache } from "./ttl-cache.js";
import { createUsageApi, defaultUsageApiDeps, defaultUsageLogPath } from "./usage-api.js";
import { appendDraftReviewComment, clearDraftReview, currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, getDraftReview, listAiReviews, listFileReviews, listFocusScans, listGuideReviews, listOverviews, listRecentPullRequests, listReviewMemoryRecords, listArchivedReviews, markPullRequestReviewed, removePullRequest, reviewMemoryStats, updateDraftReviewComment, deleteDraftReviewComment, saveAiReview, saveDraftReview, saveFocusScan, saveGuideReview, saveOverview, saveReviewMemory, saveReviewProfile, setFileViewed, updateFocusScanProgress, updateGuideReviewProgress, upsertPullRequest } from "./state.js";
import { cleanupPrWorktree, deletePrWorktree, preparePrWorktree, repoDirForRef, worktreeDirForRef, withPrWorktree } from "./worktrees.js";

// Install persistent handlers before the asynchronous ownership check. Signals during startup
// are deferred until lifecycle resources exist; repeated signals must not force Node's default exit.
let pendingShutdown: string | undefined;
let requestShutdown = (signal: string): void => { pendingShutdown ??= signal; };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => requestShutdown(signal));

// Lifetime ownership covers HTTP/file operations, preparation, agents and WebSocket terminals.
// Offline maintenance and a second server must never share this cache concurrently.
const releaseCheckoutCache = await ownServerCheckoutCache(checkoutCacheRoot());
const DEFAULT_PORT = 43133;
const WEB_ROOT = resolve(process.cwd(), "dist-web");
const execFileAsync = promisify(execFile);
const port = Number.parseInt(process.env.PI_PR_REVIEW_PORT ?? "", 10) || DEFAULT_PORT;
const compiledTerminalExtension = fileURLToPath(new URL("./pi-review-terminal-extension.js", import.meta.url));
const sourceTerminalExtension = fileURLToPath(new URL("./pi-review-terminal-extension.ts", import.meta.url));

// Test servers set PI_REVIEW_PR_CACHE_MS so 50+ opens of the same pinned PR hit GitHub once; 0/unset disables caching.
const prCacheMs = Number.parseInt(process.env.PI_REVIEW_PR_CACHE_MS ?? "", 10) || 0;
const cachedFetchPullRequestReviewData = withTtlCache(fetchPullRequestReviewData, (ref) => prKey(ref), prCacheMs);
const cachedFetchCommitChecks = withTtlCache(fetchCommitChecks, (ref, sha) => `${prKey(ref)}@${sha}`, prCacheMs);

const reviewPromptApi = createReviewPromptApi({ currentReviewMemoryPrompt });
const analysisApi = createAnalysisApi({
  contextForPr: piSessionReviewContext,
  listRecentPullRequests, listAiReviews, listFocusScans, listGuideReviews, listOverviews,
  buildPrompt: reviewPromptApi.build,
  askPi,
  modelForRun: piRunModel,
  activity: piActivity,
  saveAiReview, saveFocusScan, saveGuideReview, saveOverview,
  record: (name, data) => usageApi.record("server", name, data),
});
const piTerminalManager = createPiTerminalManager({
  apiUrl: `http://127.0.0.1:${port}`,
  cwdForPr: piSessionCwd,
  headShaForPr: (key) => piSessionReviewContext(key)?.headSha ?? null,
  extensionPath: existsSync(compiledTerminalExtension) ? compiledTerminalExtension : sourceTerminalExtension,
  logger,
});
const askStreamApi = createAskStreamApi({ askPi, logger });
const blameApi = createBlameApi({
  exists: existsSync,
  git: async (args, cwd) => (await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout,
  parsePullRequestRef,
  worktreeDirForRef,
  withPrWorktree,
});
const commentApi = createCommentApi(defaultCommentApiDeps({ addIssueComment, editIssueComment, editReviewComment, editReviewSummary, replyToReviewComment, setReviewThreadResolved }));
const draftReviewApi = createDraftReviewApi({ clearDraftReview, getDraftReview, now: () => new Date().toISOString(), saveDraftReview });
const fileApi = createFileApi(defaultFileApiDeps(fetchFileText, setFileViewed, async (url) => {
  await execFileAsync("open", [url]);
}, async (args, cwd) => (await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 })).stdout, existsSync));
const githubDraftReviewApi = createGitHubDraftReviewApi(defaultGitHubDraftReviewApiDeps({ addPendingPullRequestReviewThread, createPendingPullRequestReview, fetchPendingPullRequestReview }));
// The inbox snapshot lives next to the state file (like the usage log) so dev/test instances never share one.
const inboxSnapshotPath = `${defaultUsageLogPath().replace(/\.usage\.jsonl$/, "")}.inbox.json`;
const inboxApi = createInboxApi({
  fetchLatestActivity,
  fetchNotifications,
  fetchSubjectSnapshots,
  fetchViewerLogin,
  fetchViewerPullRequests,
  listRecentPullRequests,
  logger,
  markNotificationDone,
  now: () => new Date().toISOString(),
  async readSnapshot() {
    if (!existsSync(inboxSnapshotPath)) return null;
    return JSON.parse(await readFile(inboxSnapshotPath, "utf8")) as InboxSnapshot;
  },
  // GitHub asks pollers to wait 60s between notification reads (X-Poll-Interval); staleMs matches it.
  staleMs: 60_000,
  unsubscribeNotification,
  async writeSnapshot(snapshot) {
    await mkdir(dirname(inboxSnapshotPath), { recursive: true });
    const tempPath = `${inboxSnapshotPath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(snapshot), "utf8");
    await rename(tempPath, inboxSnapshotPath);
  },
});
// Activity ledger (focused-time heartbeats + workflow actions) also lives next to the state file.
const activityLedgerPath = resolveActivityLedgerPath({ env: process.env, configuredPath: readPiReviewLocalConfig().activityLedgerPath, defaultPath: `${defaultUsageLogPath().replace(/\.usage\.jsonl$/, "")}.activity.jsonl`, home: homedir() });
const activityApi = createActivityApi({
  readLedger: async () => existsSync(activityLedgerPath) ? await readFile(activityLedgerPath, "utf8") : "",
  async appendLedger(line) {
    await mkdir(dirname(activityLedgerPath), { recursive: true });
    await appendFile(activityLedgerPath, line, "utf8");
  },
  readUsageLog: async () => existsSync(defaultUsageLogPath()) ? await readFile(defaultUsageLogPath(), "utf8") : "",
  // Review history lives in reviewMemory; read all of it, not the prompt-sized default.
  listReviewMemoryRecords: () => listReviewMemoryRecords(Number.MAX_SAFE_INTEGER),
  listRecentPullRequests,
  now: () => new Date().toISOString(),
});
logger.info("activity", "ledger path", { path: activityLedgerPath });

// Like the inbox snapshot, the PyTorch workflow store (tracked modules + last queue snapshot) sits next to the state file.
const pytorchStorePath = `${defaultUsageLogPath().replace(/\.usage\.jsonl$/, "")}.pytorch.json`;
const pytorchWorkflowApi = createPytorchWorkflowApi({
  fetchViewerLogin,
  searchPullRequests: defaultGitHubClient.searchWorkflowPullRequests,
  searchIssues: defaultGitHubClient.searchWorkflowIssues,
  fetchPullRequest: defaultGitHubClient.fetchWorkflowPullRequest,
  listModuleLabels: () => defaultGitHubClient.listModuleLabels(PYTORCH_REPO),
  addReaction: defaultGitHubClient.addReaction,
  addLabels: defaultGitHubClient.addLabels,
  addComment: async (ref, body) => { await addIssueComment(ref, body); },
  closeIssue: defaultGitHubClient.closeIssue,
  convertToDraft: defaultGitHubClient.convertPullRequestToDraft,
  listRecentPullRequests,
  listIssueNotifications: async () => (await inboxApi.inbox()).pytorchIssues,
  assessorStatus: () => preReviewAssessor.status(),
  onQueuesRefreshed: () => preReviewAssessor.poke(),
  assessNow: (number) => preReviewAssessor.assessNow(number),
  onAction: ({ action, number, title, url }) => { void activityApi.recordAction({ action, prKey: `github.com/${PYTORCH_REPO}#${number}`, title, url }).catch((error: unknown) => logger.warn("activity", "could not record action", { error: error instanceof Error ? error.message : String(error) })); },
  logger,
  now: () => new Date().toISOString(),
  async readStore() {
    if (!existsSync(pytorchStorePath)) return null;
    return JSON.parse(await readFile(pytorchStorePath, "utf8")) as PytorchStore;
  },
  async writeStore(store) {
    await mkdir(dirname(pytorchStorePath), { recursive: true });
    const tempPath = `${pytorchStorePath}.${process.pid}.tmp`;
    await writeFile(tempPath, JSON.stringify(store), "utf8");
    await rename(tempPath, pytorchStorePath);
  },
});
const PRE_REVIEW_MODEL_TIMEOUT_MS = 10 * 60 * 1000;
/** Replaces the coding-agent system prompt so personal agent rules (status lines etc.) do not leak into the answer format. */
const PRE_REVIEW_SYSTEM_PROMPT = "You are a PyTorch maintainer doing a quick pre-review. Answer only in the format the user requests, with no status lines, state summaries, or extra sections.";
/** Headless, tool-less Pi run on the configured launcher/model; evidence is already in the prompt, so it cannot touch GitHub. */
const PRE_REVIEW_CHAT_SYSTEM_PROMPT = "You are a PyTorch maintainer's assistant discussing a pull request. Answer conversationally and concisely, with no status lines or state summaries.";
function runPreReviewModel(prompt: string, signal: AbortSignal, systemPrompt = PRE_REVIEW_SYSTEM_PROMPT): Promise<string> {
  const launch = piLaunch(["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--no-prompt-templates", "--system-prompt", systemPrompt, ...piModelArgs(), "--thinking", piThinkingLevel("high"), prompt]);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(launch.command, launch.args, { cwd: tmpdir(), env: launch.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    // Signal the group only while the leader is still running; a reaped leader's group id can be reused.
    const terminate = () => { if (child.exitCode == null && child.signalCode == null && child.pid != null) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ } } };
    const timer = setTimeout(terminate, PRE_REVIEW_MODEL_TIMEOUT_MS);
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.on("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.on("close", (code, closeSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", terminate);
      if (code === 0 && stdout.trim().length > 0) resolveRun(stdout.trim());
      else rejectRun(new Error(`pre-review model exited ${code ?? closeSignal}: ${stderr.trim().split("\n").slice(-3).join(" ") || "no output"}`));
    });
  });
}

const preReviewModelId = readPiReviewLocalConfig().model?.id ?? null;
const preReviewAssessor = createPreReviewAssessor({
  // Like the on-open warmups, test/probe servers must never start real model runs.
  enabled: process.env.PI_REVIEW_DISABLE_AUTO_REVIEWS !== "1" && process.env.PI_REVIEW_PRE_REVIEW_ASSESSOR !== "0",
  source: preReviewModelId != null && /astra/i.test(preReviewModelId) ? "Astra" : preReviewModelId ?? "Pi",
  listCandidates: () => pytorchWorkflowApi.assessmentCandidates(),
  gatherEvidence: (number) => defaultGitHubClient.fetchPreReviewEvidence({ host: "github.com", owner: "pytorch", repo: "pytorch", number }),
  buildPrompt: async (evidence) => (await reviewPromptApi.build({ mode: "pytorch-pre-review", prKey: `github.com/${PYTORCH_REPO}#${evidence.number}`, prTitle: evidence.title, author: evidence.author ?? undefined, body: evidence.body, labels: evidence.labels, linkedIssues: evidence.linkedIssues, evidence: formatPreReviewEvidence(evidence) })).prompt,
  runModel: (prompt, signal) => runPreReviewModel(prompt, signal),
  save: async ({ number, markdown, prUpdatedAt, source }) => { await pytorchWorkflowApi.saveAssessment({ number, markdown, prUpdatedAt, source }); },
  now: () => new Date().toISOString(),
  logger,
});
const preReviewChat = createPreReviewChat({
  gatherEvidence: (number) => defaultGitHubClient.fetchPreReviewEvidence({ host: "github.com", owner: "pytorch", repo: "pytorch", number }),
  runModel: (prompt, signal) => runPreReviewModel(prompt, signal, PRE_REVIEW_CHAT_SYSTEM_PROMPT),
  readAssessment: (number) => pytorchWorkflowApi.readAssessment(number),
  readThread: (number) => pytorchWorkflowApi.readChat(number),
  writeThread: (number, turns) => pytorchWorkflowApi.writeChat(number, turns),
  now: () => new Date().toISOString(),
});
const piApi = createPiApi({ askPi, piDiagnostics, setPiModel });
const piTerminalApi = createPiTerminalApi({ deleteSession: piTerminalManager.deleteSession });
const piTerminalDraftApi = createPiTerminalDraftApi({ appendDraftReviewComment, getDraftReview, updateDraftReviewComment, deleteDraftReviewComment, contextForPr: piSessionReviewContext, notifyDraftReview: piTerminalManager.broadcastDraftReview });
const prApi = createPrApi(defaultPrApiDeps({
  cleanupPrWorktree,
  deletePrWorktree,
  compareCommits,
  compareCommitsLocally: createGitInterdiff({
    exists: existsSync,
    git: async (args, cwd) => (await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 })).stdout,
    repoDirForRef,
  }),
  fetchCommitChecks: cachedFetchCommitChecks,
  disposePiSession: async (prKey) => {
    analysisApi.invalidate(prKey);
    await Promise.all([disposePiSession(prKey), piTerminalManager.disposePr(prKey)]);
  },
  fetchPullRequestReviewData: cachedFetchPullRequestReviewData,
  fetchFreshPullRequestReviewData: cachedFetchPullRequestReviewData.refresh,
  recoverMissingPatches: createMissingPatchRecovery({
    git: async (args, cwd) => (await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024, timeout: 30_000 })).stdout,
    warn: (message, details) => logger.warn("diff", message, details),
  }),
  getDraftReview,
  listAiReviews,
  listFileReviews,
  listFocusScans,
  listGuideReviews,
  listOverviews,
  preparePrWorktree,
  prewarmPiSession: process.env.PI_REVIEW_DISABLE_AUTO_REVIEWS === "1" ? () => undefined : prewarmPiSession,
  registerPiSessionContext,
  removePullRequest,
  upsertPullRequest,
}));
const reviewArchiveApi = createReviewArchiveApi(defaultReviewArchiveApiDeps({ clearDraftReview, listArchivedReviews, fetchPullRequestReviewData: cachedFetchPullRequestReviewData, markPullRequestReviewed, saveReviewMemory }));
const reviewMemoryApi = createReviewMemoryApi({ askPi, currentReviewMemoryDistillationSource, currentReviewMemoryPrompt, currentReviewProfile, listReviewMemoryRecords, reviewMemoryStats, saveReviewMemory, saveReviewProfile });
const reviewSubmitRouteApi = createReviewSubmitRouteApi(defaultReviewSubmitRouteApiDeps({ clearDraftReview, fetchPullRequestReviewData: cachedFetchPullRequestReviewData, markPullRequestReviewed, saveReviewMemory, submitPullRequestReview }));
const savedAnalysisApi = createSavedAnalysisApi({ listAiReviews, saveAiReview, saveFocusScan, saveGuideReview, saveOverview, updateFocusScanProgress, updateGuideReviewProgress });
const shellApi = createShellApi({ listRecentPullRequests, logEntries: logger.entries, hasCheckout: (ref) => existsSync(worktreeDirForRef(ref)) });
const usageApi = createUsageApi(defaultUsageApiDeps(logger));

// Identifies the currently served web build so open tabs can notice in-place
// rebuilds of dist-web; keyed by index.html's mtime so it tracks rebuilds
// without restarting the server.
let assetsVersionCache: { mtimeMs: number; value: string } | null = null;
function assetsVersion(): string {
  try {
    const indexPath = join(WEB_ROOT, "index.html");
    const mtimeMs = statSync(indexPath).mtimeMs;
    if (assetsVersionCache?.mtimeMs !== mtimeMs) {
      assetsVersionCache = { mtimeMs, value: createHash("sha1").update(readFileSync(indexPath)).digest("hex").slice(0, 16) };
    }
    return assetsVersionCache.value;
  } catch {
    return "unbuilt";
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

const route = createServerRoute({
  activityApi,
  // localFileText advertises that /api/file/text is served from the PR clone, so the web app may fetch file text freely.
  serverConfig: () => ({ autoReviews: process.env.PI_REVIEW_DISABLE_AUTO_REVIEWS !== "1", localFileText: true }),
  analysisApi,
  askStreamApi,
  blameApi,
  commentApi,
  draftReviewApi,
  fileApi,
  githubDraftReviewApi,
  gpuWorkspaceCreateResponse,
  gpuWorkspaceDeleteResponse,
  gpuWorkspaceExecResponse,
  gpuWorkspaceStatusResponse,
  inboxApi,
  logger,
  piApi,
  piTerminalApi,
  piTerminalDraftApi,
  prApi,
  pytorchWorkflowApi,
  preReviewChat,
  reviewArchiveApi,
  reviewMemoryApi,
  reviewPromptApi,
  reviewSubmitRouteApi,
  savedAnalysisApi,
  sendStatic,
  shellApi,
  usageApi,
});

const server = createServer(createRequestListener(route, logger, (name, data) => usageApi.record("server", name, data), assetsVersion));
const detachPiTerminalWebSocketServer = attachPiTerminalWebSocketServer(server, piTerminalManager, logger);

async function shutdown(signal: string): Promise<void> {
  if (signal !== "retry") logger.info("server", "shutdown", { signal });
  detachPiTerminalWebSocketServer();
  server.closeAllConnections();
  await Promise.all([
    preReviewAssessor.stop(),
    Promise.resolve(preReviewChat.stop()),
    new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    piTerminalManager.dispose(),
    disposePiSessions(),
  ]);
}

requestShutdown = createShutdownRequest({
  stop: shutdown,
  stopped: () => { releaseCheckoutCache(); process.exit(0); },
  failed: (error, signal) => logger.error("server", "shutdown blocked; cache ownership retained — close remaining Pi processes; cleanup will retry", { signal, pid: process.pid, error: error instanceof Error ? error.message : String(error) }),
});
if (pendingShutdown != null) {
  requestShutdown(pendingShutdown);
} else {
  server.listen(port, "127.0.0.1", () => {
    logger.info("server", "listening", { url: `http://127.0.0.1:${port}`, webRoot: WEB_ROOT });
    preReviewAssessor.start();
    usageApi.record("server", "server:start");
  });
}
