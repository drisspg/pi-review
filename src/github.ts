import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { markGeneratedPullFiles, parseGitattributes, type GitattributesRule } from "./gitattributes.js";
import { logger } from "./logger.js";
import { prKey } from "./pr.js";
import type { InboxSubjectRef } from "./inbox-api.js";
import type { CheckRollupState, CommitChecks, GitHubDraftComment, GitHubNotification, InboxLatestActivity, GitHubDraftCommentInput, GitHubPendingReview, GitHubPendingReviewLookup, InboxSubjectKind, InboxSubjectSnapshot, PullFile, PullIssueComment, PullRequest, PullRequestRef, PullRequestReviewData, PullRequestReviewDecision, PullRequestReviewSummary, PullReviewComment, StoredPullRequest, ViewerPullRequest, ViewerPullRequestScope } from "./types.js";

const execFileAsync = promisify(execFile);

export type ExecFileOptions = { maxBuffer: number };

export type GitHubRuntime = {
  execFile: (command: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  now: () => string;
  writeFile: (path: string, data: string) => Promise<void>;
};

export type GitHubClient = {
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  compareCommits: (ref: PullRequestRef, baseSha: string, headSha: string) => Promise<{ files: PullFile[]; totalCommits: number }>;
  fetchCommitChecks: (ref: PullRequestRef, sha: string) => Promise<CommitChecks>;
  fetchFileText: (ref: PullRequestRef, path: string, sha: string) => Promise<string>;
  fetchPendingPullRequestReview: (ref: PullRequestRef) => Promise<GitHubPendingReviewLookup>;
  createPendingPullRequestReview: (ref: PullRequestRef, pullRequestId: string) => Promise<string>;
  addPendingPullRequestReviewThread: (ref: PullRequestRef, reviewId: string, comment: GitHubDraftCommentInput) => Promise<void>;
  submitPullRequestReview: (ref: PullRequestRef, payload: unknown) => Promise<unknown>;
  replyToReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  addIssueComment: (ref: PullRequestRef, body: string) => Promise<unknown>;
  editReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editIssueComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editReviewSummary: (ref: PullRequestRef, reviewId: number, body: string) => Promise<unknown>;
  fetchViewerLogin: () => Promise<string | null>;
  fetchNotifications: () => Promise<GitHubNotification[]>;
  fetchSubjectSnapshots: (refs: InboxSubjectRef[]) => Promise<InboxSubjectSnapshot[]>;
  fetchViewerPullRequests: (login: string, scope: ViewerPullRequestScope) => Promise<ViewerPullRequest[]>;
  fetchLatestActivity: (urls: string[], login: string | null) => Promise<Map<string, InboxLatestActivity>>;
  markNotificationDone: (threadId: string) => Promise<void>;
  unsubscribeNotification: (threadId: string) => Promise<void>;
};

const defaultRuntime: GitHubRuntime = {
  async execFile(command, args, options) {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return { stdout, stderr };
  },
  async mkdtemp(prefix) {
    return await mkdtemp(prefix);
  },
  async rm(path) {
    await rm(path, { recursive: true, force: true });
  },
  now: () => new Date().toISOString(),
  async writeFile(path, data) {
    await writeFile(path, data, "utf8");
  },
};

type ReviewThreadGraphql = { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id: string; isResolved: boolean; comments?: { nodes?: Array<{ databaseId: number | null }> } }> } } } } };
type ReviewDecisionGraphql = { data?: { repository?: { pullRequest?: { reviewDecision?: PullRequestReviewDecision } } } };
type GraphqlResponse<T> = { data?: T; errors?: Array<{ message?: string }> };
type NotificationRest = { id?: string; reason?: string; unread?: boolean; updated_at?: string; subject?: { title?: string; url?: string | null; latest_comment_url?: string | null; type?: string }; repository?: { full_name?: string } };
type SnapshotGraphql = { number?: number; url?: string; state?: string; merged?: boolean; isDraft?: boolean; reviewDecision?: PullRequestReviewDecision; updatedAt?: string; author?: { login?: string } | null; commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> } };
type ViewerPullGraphql = SnapshotGraphql & { title?: string; mergeable?: string; closedAt?: string | null; mergedAt?: string | null; headRefOid?: string; repository?: { nameWithOwner?: string }; reviewRequests?: { nodes?: Array<{ requestedReviewer?: { login?: string; name?: string } | null }> }; commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string; contexts?: { nodes?: Array<{ name?: string; context?: string; conclusion?: string | null; status?: string; state?: string }> } } | null } }> } };
type LatestCommentRest = { user?: { login?: string; type?: string } | null; body?: string | null; html_url?: string };
type ViewerPullsGraphql = { search?: { nodes?: ViewerPullGraphql[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
type PendingReviewCommentGraphql = { id?: string; path?: string; line?: number | null; startLine?: number | null; subjectType?: "LINE" | "FILE"; body?: string; url?: string };
type PendingReviewGraphql = { id?: string; body?: string; state?: string; updatedAt?: string; viewerDidAuthor?: boolean; comments?: { nodes?: PendingReviewCommentGraphql[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };

function apiBase(ref: PullRequestRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

function pendingReviewComment(comment: PendingReviewCommentGraphql): GitHubDraftComment {
  if (typeof comment.id !== "string" || typeof comment.path !== "string" || typeof comment.body !== "string" || typeof comment.url !== "string") throw new Error("GitHub returned an invalid pending review comment");
  return {
    id: comment.id,
    path: comment.path,
    line: typeof comment.line === "number" ? comment.line : null,
    startLine: typeof comment.startLine === "number" ? comment.startLine : null,
    subjectType: comment.subjectType === "FILE" ? "FILE" : "LINE",
    body: comment.body,
    url: comment.url,
  };
}

function pendingReview(review: PendingReviewGraphql, comments: PendingReviewCommentGraphql[]): GitHubPendingReview {
  if (typeof review.id !== "string") throw new Error("GitHub returned an invalid pending review");
  return {
    id: review.id,
    body: typeof review.body === "string" ? review.body : "",
    comments: comments.map(pendingReviewComment),
    updatedAt: typeof review.updatedAt === "string" ? review.updatedAt : "",
  };
}

function reviewEventFromState(state: string): StoredPullRequest["lastReviewEvent"] {
  if (state === "APPROVED") return "APPROVE";
  if (state === "CHANGES_REQUESTED") return "REQUEST_CHANGES";
  return "COMMENT";
}

/**
 * The head SHA of the viewer's most recent submitted review, so re-review
 * interdiffs work even when the review happened on GitHub itself or before
 * this app started recording reviews. Local records still win on upsert.
 */
function latestViewerReview(reviews: PullRequestReviewSummary[], viewer: string | null): PullRequestReviewSummary | null {
  if (viewer == null) return null;
  const own = reviews.filter((review) => review.user?.login === viewer && typeof review.commit_id === "string" && review.commit_id.length > 0 && review.submitted_at != null);
  own.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  return own[0] ?? null;
}

function toStoredPullRequest(ref: PullRequestRef, pr: PullRequest, files: PullFile[], comments: PullReviewComment[], issueComments: PullIssueComment[], reviewSummaries: PullRequestReviewSummary[], reviewDecision: PullRequestReviewDecision, now: string, viewerReview: PullRequestReviewSummary | null): StoredPullRequest {
  return {
    key: prKey(ref),
    ref,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.state,
    merged: pr.merged === true || (pr.state === "closed" && pr.labels?.some((label) => label.name?.trim().toLowerCase() === "merged") === true),
    author: pr.user?.login ?? null,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    filesChanged: files.length,
    existingCommentCount: comments.length + issueComments.length + reviewSummaries.length,
    lastOpenedAt: now,
    lastReviewedHeadSha: viewerReview?.commit_id ?? null,
    lastReviewEvent: viewerReview == null ? null : reviewEventFromState(viewerReview.state),
    reviewDecision,
  };
}

function fileFingerprint(file: PullFile): string {
  return createHash("sha1").update(`${file.status}\n${file.previous_filename ?? ""}\n${file.patch ?? ""}`).digest("hex");
}

function subjectKindFromRest(type: string | undefined): InboxSubjectKind {
  if (type === "PullRequest") return "pr";
  if (type === "Issue") return "issue";
  return "other";
}

function subjectNumberFromUrl(url: string | null | undefined): number | null {
  const match = /\/(?:pulls|issues)\/(\d+)$/.exec(url ?? "");
  return match == null ? null : Number.parseInt(match[1], 10);
}

function toNotification(raw: NotificationRest): GitHubNotification | null {
  if (typeof raw.id !== "string" || typeof raw.repository?.full_name !== "string") return null;
  return {
    id: raw.id,
    reason: raw.reason ?? "subscribed",
    unread: raw.unread !== false,
    updatedAt: raw.updated_at ?? "",
    repo: raw.repository.full_name,
    subjectKind: subjectKindFromRest(raw.subject?.type),
    subjectNumber: subjectNumberFromUrl(raw.subject?.url),
    subjectTitle: raw.subject?.title ?? "(untitled)",
    latestCommentUrl: raw.subject?.latest_comment_url ?? null,
  };
}

function checkRollupState(node: SnapshotGraphql): CheckRollupState {
  const state = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return state === "SUCCESS" || state === "FAILURE" || state === "ERROR" || state === "PENDING" || state === "EXPECTED" ? state : null;
}

function snapshotState(node: SnapshotGraphql): InboxSubjectSnapshot["state"] {
  if (node.merged === true || node.state === "MERGED") return "MERGED";
  if (node.state === "OPEN" || node.state === "CLOSED") return node.state;
  return null;
}

function toSnapshot(ref: InboxSubjectRef, node: SnapshotGraphql): InboxSubjectSnapshot {
  return {
    key: `${ref.repo}#${ref.number}`,
    kind: ref.kind,
    url: node.url ?? `https://github.com/${ref.repo}/${ref.kind === "pr" ? "pull" : "issues"}/${ref.number}`,
    state: snapshotState(node),
    isDraft: node.isDraft === true,
    author: node.author?.login ?? null,
    reviewDecision: node.reviewDecision ?? null,
    checks: checkRollupState(node),
    updatedAt: node.updatedAt ?? null,
  };
}

function toViewerPullRequest(node: ViewerPullGraphql): ViewerPullRequest | null {
  const repo = node.repository?.nameWithOwner;
  if (typeof repo !== "string" || typeof node.number !== "number") return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const failingChecks = (rollup?.contexts?.nodes ?? []).filter((context) => context.conclusion === "FAILURE" || context.conclusion === "TIMED_OUT" || context.state === "FAILURE" || context.state === "ERROR").map((context) => context.name ?? context.context ?? "check");
  const mergeable = node.mergeable === "MERGEABLE" || node.mergeable === "CONFLICTING" ? node.mergeable : "UNKNOWN";
  return {
    key: `${repo}#${node.number}`,
    repo,
    number: node.number,
    title: node.title ?? "(untitled)",
    url: node.url ?? `https://github.com/${repo}/pull/${node.number}`,
    state: node.merged === true || node.state === "MERGED" ? "MERGED" : node.state === "CLOSED" ? "CLOSED" : "OPEN",
    closedAt: node.mergedAt ?? node.closedAt ?? null,
    isDraft: node.isDraft === true,
    reviewDecision: node.reviewDecision ?? null,
    mergeable,
    checks: checkRollupState(node),
    failingChecks,
    reviewers: (node.reviewRequests?.nodes ?? []).map((request) => request.requestedReviewer?.login ?? request.requestedReviewer?.name).filter((name): name is string => typeof name === "string"),
    updatedAt: node.updatedAt ?? "",
    headSha: node.headRefOid ?? "",
    localPrKey: null,
  };
}

const KNOWN_BOTS = new Set(["pytorchmergebot", "pytorch-bot", "facebook-github-bot", "github-actions", "dependabot", "codecov", "meta-codesync"]);
const LATEST_ACTIVITY_CONCURRENCY = 6;
const RECENTLY_CLOSED_DAYS = 14;

function isBotLogin(user: LatestCommentRest["user"]): boolean {
  const login = user?.login ?? "";
  return user?.type === "Bot" || login.endsWith("[bot]") || KNOWN_BOTS.has(login.toLowerCase());
}

function toLatestActivity(raw: LatestCommentRest, fallbackUrl: string, login: string | null): InboxLatestActivity {
  const body = (raw.body ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  return {
    author: raw.user?.login ?? null,
    bot: isBotLogin(raw.user),
    pingsViewer: login != null && new RegExp(`@${login}\\b`, "i").test(body),
    snippet: body.length > 200 ? `${body.slice(0, 197)}…` : body,
    url: raw.html_url ?? fallbackUrl,
  };
}

/** Run async work over a list with bounded concurrency, keeping result order irrelevant (callers key by input). */
async function mapWithConcurrency<T>(inputs: string[], limit: number, work: (input: string) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, async () => {
    while (cursor < inputs.length) {
      const input = inputs[cursor];
      cursor += 1;
      results.push(await work(input));
    }
  }));
  return results;
}

const SNAPSHOT_FIELDS = "number url state isDraft reviewDecision updatedAt author { login } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
const ISSUE_FIELDS = "number url state updatedAt author { login }";
const SNAPSHOT_BATCH = 40;

export function createGitHubClient(runtime: GitHubRuntime = defaultRuntime): GitHubClient {
  let viewerLoginPromise: Promise<string | null> | null = null;

  function fetchViewerLogin(): Promise<string | null> {
    viewerLoginPromise ??= ghApi<{ login?: string }>("/user").then((user) => user.login ?? null).catch((error: unknown) => {
      logger.warn("github", "fetch viewer login failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    return viewerLoginPromise;
  }

  async function ghApi<T>(path: string): Promise<T> {
    const startedAt = performance.now();
    logger.info("github", "gh api start", { path });
    try {
      const { stdout, stderr } = await runtime.execFile("gh", ["api", path], { maxBuffer: 50 * 1024 * 1024 });
      logger.info("github", "gh api complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
      return JSON.parse(stdout) as T;
    } catch (error) {
      logger.error("github", "gh api failed", { path, ms: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function ghGraphql<T>(query: string, variables: Record<string, string | number>, scope: string, options: { allowPartial?: boolean } = {}): Promise<T> {
    const startedAt = performance.now();
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    logger.info("github", `${scope} start`);
    try {
      const { stdout, stderr } = await runtime.execFile("gh", args, { maxBuffer: 50 * 1024 * 1024 }).catch((error: unknown) => {
        // gh exits non-zero when a GraphQL response carries partial errors but still prints the JSON body.
        const partialStdout = typeof (error as { stdout?: unknown })?.stdout === "string" ? (error as { stdout: string }).stdout : "";
        if (options.allowPartial && partialStdout.trim().startsWith("{")) return { stdout: partialStdout, stderr: "" };
        throw error;
      });
      const response = JSON.parse(stdout) as GraphqlResponse<T>;
      if (response.errors?.length) {
        const message = response.errors.map((error) => error.message ?? "GraphQL error").join("; ");
        if (!options.allowPartial || response.data == null) throw new Error(message);
        logger.warn("github", `${scope} partial`, { errors: message.slice(0, 500) });
      }
      if (response.data == null) throw new Error("GitHub GraphQL response did not include data");
      logger.info("github", `${scope} complete`, { ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
      return response.data;
    } catch (error) {
      logger.error("github", `${scope} failed`, { ms: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function fetchReviewDecision(ref: PullRequestRef): Promise<PullRequestReviewDecision> {
    if (ref.host !== "github.com") return null;
    const query = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } } }`;
    try {
      const { stdout } = await runtime.execFile("gh", ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${ref.owner}`, "-F", `repo=${ref.repo}`, "-F", `number=${ref.number}`], { maxBuffer: 50 * 1024 * 1024 });
      return (JSON.parse(stdout) as ReviewDecisionGraphql).data?.repository?.pullRequest?.reviewDecision ?? null;
    } catch (error) {
      logger.warn("github", "fetch review decision failed", { ref, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async function fetchRootGitattributes(ref: PullRequestRef, sha: string): Promise<GitattributesRule[] | null> {
    const endpoint = `/repos/${ref.owner}/${ref.repo}/contents/.gitattributes?ref=${sha}`;
    try {
      const { stdout } = await runtime.execFile("gh", ["api", endpoint, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 1024 * 1024 });
      const rules = parseGitattributes(stdout);
      logger.info("github", "fetched gitattributes", { ref, sha: sha.slice(0, 12), rules: rules.length });
      return rules;
    } catch (error) {
      logger.info("github", "gitattributes unavailable", { ref, sha: sha.slice(0, 12), error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  async function fetchReviewThreadStates(ref: PullRequestRef): Promise<Map<number, { thread_id: string; thread_resolved: boolean }>> {
    if (ref.host !== "github.com") return new Map();
    const query = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 100) { nodes { databaseId } } } } } } }`;
    const startedAt = performance.now();
    logger.info("github", "fetch review thread states start", { ref });
    let stdout = "";
    try {
      ({ stdout } = await runtime.execFile("gh", ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${ref.owner}`, "-F", `repo=${ref.repo}`, "-F", `number=${ref.number}`], { maxBuffer: 50 * 1024 * 1024 }));
    } catch (error) {
      logger.warn("github", "fetch review thread states failed", { ref, error: error instanceof Error ? error.message : String(error) });
      return new Map();
    }
    const data = JSON.parse(stdout) as ReviewThreadGraphql;
    const states = new Map<number, { thread_id: string; thread_resolved: boolean }>();
    for (const thread of data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
      for (const comment of thread.comments?.nodes ?? []) {
        if (comment.databaseId != null) states.set(comment.databaseId, { thread_id: thread.id, thread_resolved: thread.isResolved });
      }
    }
    logger.info("github", "fetch review thread states complete", { ref, ms: Math.round(performance.now() - startedAt), threads: data.data?.repository?.pullRequest?.reviewThreads?.nodes?.length ?? 0, comments: states.size });
    return states;
  }

  async function fetchPullRequestReviewData(ref: PullRequestRef): Promise<PullRequestReviewData> {
    logger.info("github", "fetch PR review data", { ref });
    const rawPrPromise = ghApi<PullRequest>(apiBase(ref));
    const gitattributesPromise = rawPrPromise.then((pr) => fetchRootGitattributes(ref, pr.head.sha));
    const [rawPr, rawFiles, rawComments, issueComments, rawReviewSummaries, threadStates, reviewDecision, gitattributes, viewer] = await Promise.all([
      rawPrPromise,
      ghApi<PullFile[]>(`${apiBase(ref)}/files`),
      ghApi<PullReviewComment[]>(`${apiBase(ref)}/comments`),
      ghApi<PullIssueComment[]>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`),
      ghApi<PullRequestReviewSummary[]>(`${apiBase(ref)}/reviews`),
      fetchReviewThreadStates(ref),
      fetchReviewDecision(ref),
      gitattributesPromise,
      fetchViewerLogin(),
    ]);
    const files = markGeneratedPullFiles(rawFiles, gitattributes);
    const comments = rawComments.map((comment) => ({ ...comment, ...threadStates.get(comment.id) }));
    const reviewSummaries = rawReviewSummaries.filter((review) => review.body.trim().length > 0);
    const pr = toStoredPullRequest(ref, rawPr, files, comments, issueComments, reviewSummaries, reviewDecision, runtime.now(), latestViewerReview(rawReviewSummaries, viewer));
    logger.info("github", "fetched PR review data", { key: pr.key, title: pr.title, files: files.length, reviewComments: comments.length, issueComments: issueComments.length, reviewSummaries: reviewSummaries.length });
    // Viewed flags are local mutable state resolved at request time in pr-api; this cached fetch only supplies fingerprints.
    const fileReviews = files.map((file) => ({ prKey: pr.key, path: file.filename, fingerprint: fileFingerprint(file), viewed: false, updatedAt: runtime.now() }));
    return { pr, raw: rawPr, files, comments, issueComments, reviewSummaries, fileReviews };
  }

  /** Diff two arbitrary commits of the PR repo, e.g. the previously reviewed head vs the current head. */
  async function compareCommits(ref: PullRequestRef, baseSha: string, headSha: string): Promise<{ files: PullFile[]; totalCommits: number }> {
    const data = await ghApi<{ total_commits?: number; files?: PullFile[] }>(`/repos/${ref.owner}/${ref.repo}/compare/${baseSha}...${headSha}`);
    const gitattributes = await fetchRootGitattributes(ref, headSha);
    const files = markGeneratedPullFiles(data.files ?? [], gitattributes);
    logger.info("github", "compared commits", { ref, baseSha: baseSha.slice(0, 12), headSha: headSha.slice(0, 12), files: files.length, commits: data.total_commits ?? 0 });
    return { files, totalCommits: data.total_commits ?? 0 };
  }

  async function fetchCommitChecks(ref: PullRequestRef, sha: string): Promise<CommitChecks> {
    type CheckRun = { name?: string; status?: string; conclusion?: string | null; html_url?: string | null };
    const runs: CheckRun[] = [];
    let total = 0;
    for (let page = 1; page <= 5; page += 1) {
      const data = await ghApi<{ total_count?: number; check_runs?: CheckRun[] }>(`/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      total = data.total_count ?? 0;
      runs.push(...(data.check_runs ?? []));
      if (runs.length >= total || (data.check_runs?.length ?? 0) === 0) break;
    }
    const checks: CommitChecks = { total, success: 0, failure: 0, pending: 0, neutral: 0, failures: [] };
    for (const run of runs) {
      if (run.status !== "completed") checks.pending += 1;
      else if (run.conclusion === "success") checks.success += 1;
      else if (run.conclusion === "neutral" || run.conclusion === "skipped" || run.conclusion === "stale") checks.neutral += 1;
      else {
        checks.failure += 1;
        if (checks.failures.length < 30) checks.failures.push({ name: run.name ?? "unknown check", url: run.html_url ?? null });
      }
    }
    logger.info("github", "fetched commit checks", { ref, sha: sha.slice(0, 12), total: checks.total, failure: checks.failure, pending: checks.pending });
    return checks;
  }

  async function fetchFileText(ref: PullRequestRef, path: string, sha: string): Promise<string> {
    const endpoint = `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${sha}`;
    const startedAt = performance.now();
    logger.info("github", "fetch file text start", { path, sha: sha.slice(0, 12) });
    const { stdout } = await runtime.execFile("gh", ["api", endpoint, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 50 * 1024 * 1024 });
    logger.info("github", "fetch file text complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length });
    return stdout.replace(/\r\n/g, "\n");
  }

  async function fetchPendingPullRequestReview(ref: PullRequestRef): Promise<GitHubPendingReviewLookup> {
    const query = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id reviews(first: 10, states: [PENDING]) { nodes { id body state updatedAt viewerDidAuthor comments(first: 100) { nodes { id path line startLine subjectType body url } pageInfo { hasNextPage endCursor } } } } } } }`;
    const data = await ghGraphql<{ repository?: { pullRequest?: { id?: string; reviews?: { nodes?: PendingReviewGraphql[] } } } }>(query, { owner: ref.owner, repo: ref.repo, number: ref.number }, "fetch pending review");
    const pullRequest = data.repository?.pullRequest;
    if (typeof pullRequest?.id !== "string") throw new Error("GitHub pull request was not found");
    const review = pullRequest.reviews?.nodes?.find((candidate) => candidate.state === "PENDING" && candidate.viewerDidAuthor === true);
    if (review == null) return { pullRequestId: pullRequest.id, review: null };
    if (typeof review.id !== "string") throw new Error("GitHub returned an invalid pending review");
    const comments = [...(review.comments?.nodes ?? [])];
    let pageInfo = review.comments?.pageInfo;
    while (pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === "string") {
      const commentsQuery = `query($reviewId: ID!, $after: String!) { node(id: $reviewId) { ... on PullRequestReview { comments(first: 100, after: $after) { nodes { id path line startLine subjectType body url } pageInfo { hasNextPage endCursor } } } } }`;
      const next = await ghGraphql<{ node?: { comments?: { nodes?: PendingReviewCommentGraphql[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } }>(commentsQuery, { reviewId: review.id, after: pageInfo.endCursor }, "fetch pending review comments");
      comments.push(...(next.node?.comments?.nodes ?? []));
      pageInfo = next.node?.comments?.pageInfo;
    }
    return { pullRequestId: pullRequest.id, review: pendingReview(review, comments) };
  }

  async function createPendingPullRequestReview(_ref: PullRequestRef, pullRequestId: string): Promise<string> {
    const mutation = `mutation($pullRequestId: ID!) { addPullRequestReview(input: { pullRequestId: $pullRequestId }) { pullRequestReview { id } } }`;
    const data = await ghGraphql<{ addPullRequestReview?: { pullRequestReview?: { id?: string } } }>(mutation, { pullRequestId }, "create pending review");
    const reviewId = data.addPullRequestReview?.pullRequestReview?.id;
    if (typeof reviewId !== "string") throw new Error("GitHub did not return the new pending review");
    return reviewId;
  }

  async function addPendingPullRequestReviewThread(_ref: PullRequestRef, reviewId: string, comment: GitHubDraftCommentInput): Promise<void> {
    const mutation = `mutation($reviewId: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType!) { addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, path: $path, body: $body, line: $line, side: $side, startLine: $startLine, startSide: $startSide, subjectType: $subjectType }) { thread { id } } }`;
    const variables: Record<string, string | number> = { reviewId, path: comment.path, body: comment.body, subjectType: comment.line == null ? "FILE" : "LINE" };
    if (comment.line != null) {
      variables.line = comment.line;
      variables.side = comment.side;
    }
    if (comment.startLine != null && comment.startLine !== comment.line) {
      variables.startLine = comment.startLine;
      variables.startSide = comment.side;
    }
    await ghGraphql(mutation, variables, "add pending review thread");
  }

  async function ghApiWrite(ref: PullRequestRef, method: "POST" | "PATCH", path: string, payload: unknown, scope: string): Promise<unknown> {
    const dir = await runtime.mkdtemp(join(tmpdir(), "pi-review-"));
    const inputPath = join(dir, "payload.json");
    await runtime.writeFile(inputPath, JSON.stringify(payload));
    const startedAt = performance.now();
    let failed = false;
    logger.info("github", `${scope} start`, { ref });
    try {
      const { stdout, stderr } = await runtime.execFile("gh", ["api", path, "--method", method, "--input", inputPath], { maxBuffer: 50 * 1024 * 1024 });
      logger.info("github", `${scope} complete`, { ref, ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
      return JSON.parse(stdout) as unknown;
    } catch (error) {
      failed = true;
      logger.error("github", `${scope} failed`, { ref, inputPath, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      if (!failed) await runtime.rm(dir);
    }
  }

  async function ghApiPost(ref: PullRequestRef, path: string, payload: unknown, scope: string): Promise<unknown> {
    return ghApiWrite(ref, "POST", path, payload, scope);
  }

  async function ghApiPatch(ref: PullRequestRef, path: string, payload: unknown, scope: string): Promise<unknown> {
    return ghApiWrite(ref, "PATCH", path, payload, scope);
  }

  async function submitPullRequestReview(ref: PullRequestRef, payload: unknown): Promise<unknown> {
    return ghApiPost(ref, apiBase(ref) + "/reviews", payload, "submit review");
  }

  async function replyToReviewComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
    return ghApiPost(ref, `${apiBase(ref)}/comments/${commentId}/replies`, { body }, "reply review comment");
  }

  async function addIssueComment(ref: PullRequestRef, body: string): Promise<unknown> {
    return ghApiPost(ref, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body }, "add issue comment");
  }

  async function editReviewComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
    return ghApiPatch(ref, `/repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`, { body }, "edit review comment");
  }

  async function editIssueComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
    return ghApiPatch(ref, `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`, { body }, "edit issue comment");
  }

  async function editReviewSummary(ref: PullRequestRef, reviewId: number, body: string): Promise<unknown> {
    return ghApiPatch(ref, `${apiBase(ref)}/reviews/${reviewId}`, { body }, "edit review summary");
  }

  async function fetchNotifications(): Promise<GitHubNotification[]> {
    const pages = await ghApiArgs<unknown>(["--paginate", "--slurp", "notifications?per_page=100"]);
    const raw = (Array.isArray(pages) ? pages : []).flatMap((page) => (Array.isArray(page) ? page : [page])) as NotificationRest[];
    return raw.map(toNotification).filter((notification): notification is GitHubNotification => notification != null);
  }

  async function ghApiArgs<T>(args: string[]): Promise<T> {
    const startedAt = performance.now();
    logger.info("github", "gh api start", { path: args.join(" ") });
    try {
      const { stdout, stderr } = await runtime.execFile("gh", ["api", ...args], { maxBuffer: 50 * 1024 * 1024 });
      logger.info("github", "gh api complete", { path: args.join(" "), ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
      return (stdout.trim().length === 0 ? null : JSON.parse(stdout)) as T;
    } catch (error) {
      logger.error("github", "gh api failed", { path: args.join(" "), ms: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function fetchSubjectSnapshots(refs: InboxSubjectRef[]): Promise<InboxSubjectSnapshot[]> {
    const batches: InboxSubjectRef[][] = [];
    for (let index = 0; index < refs.length; index += SNAPSHOT_BATCH) batches.push(refs.slice(index, index + SNAPSHOT_BATCH));
    const results = await Promise.all(batches.map(async (batch, batchIndex) => {
      const aliases = batch.map((ref, index) => {
        const [owner, repo] = ref.repo.split("/");
        const field = ref.kind === "pr" ? `pullRequest(number: ${ref.number}) { ${SNAPSHOT_FIELDS} }` : `issue(number: ${ref.number}) { ${ISSUE_FIELDS} }`;
        return `s${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${field} }`;
      });
      const data = await ghGraphql<Record<string, { pullRequest?: SnapshotGraphql | null; issue?: SnapshotGraphql | null } | null>>(`query { ${aliases.join(" ")} }`, {}, `inbox snapshots ${batchIndex + 1}/${batches.length}`, { allowPartial: true });
      return batch.flatMap((ref, index) => {
        const node = data[`s${index}`]?.pullRequest ?? data[`s${index}`]?.issue;
        return node == null ? [] : [toSnapshot(ref, node)];
      });
    }));
    return results.flat();
  }

  async function fetchViewerPullRequests(login: string, scope: ViewerPullRequestScope): Promise<ViewerPullRequest[]> {
    const query = `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number url state merged closedAt mergedAt isDraft reviewDecision updatedAt author { login } title mergeable headRefOid repository { nameWithOwner } reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } } commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } } } } } }`;
    const since = new Date(Date.parse(runtime.now()) - RECENTLY_CLOSED_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const filter = scope === "open" ? "is:open" : `is:closed closed:>=${since}`;
    const prs: ViewerPullRequest[] = [];
    let after: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const variables: Record<string, string> = { q: `is:pr archived:false author:${login} ${filter} sort:updated-desc` };
      if (after != null) variables.after = after;
      const data: ViewerPullsGraphql = await ghGraphql<ViewerPullsGraphql>(query, variables, `viewer ${scope} PRs page ${page + 1}`, { allowPartial: true });
      for (const node of data.search?.nodes ?? []) {
        const pr = toViewerPullRequest(node);
        if (pr != null) prs.push(pr);
      }
      if (data.search?.pageInfo?.hasNextPage !== true || data.search.pageInfo.endCursor == null) break;
      after = data.search.pageInfo.endCursor;
    }
    prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return prs;
  }

  async function fetchLatestActivity(urls: string[], login: string | null): Promise<Map<string, InboxLatestActivity>> {
    const unique = [...new Set(urls)];
    const entries = await mapWithConcurrency(unique, LATEST_ACTIVITY_CONCURRENCY, async (url) => {
      try {
        const raw = await ghApi<LatestCommentRest>(url);
        return [url, toLatestActivity(raw, url, login)] as const;
      } catch {
        return null;
      }
    });
    return new Map(entries.filter((entry): entry is readonly [string, InboxLatestActivity] => entry != null));
  }

  async function markNotificationDone(threadId: string): Promise<void> {
    await ghApiArgs<unknown>(["--method", "DELETE", `/notifications/threads/${encodeURIComponent(threadId)}`]);
  }

  async function unsubscribeNotification(threadId: string): Promise<void> {
    await ghApiArgs<unknown>(["--method", "DELETE", `/notifications/threads/${encodeURIComponent(threadId)}/subscription`]);
  }

  return { fetchPullRequestReviewData, compareCommits, fetchCommitChecks, fetchFileText, fetchPendingPullRequestReview, createPendingPullRequestReview, addPendingPullRequestReviewThread, submitPullRequestReview, replyToReviewComment, addIssueComment, editReviewComment, editIssueComment, editReviewSummary, fetchViewerLogin, fetchNotifications, fetchSubjectSnapshots, fetchViewerPullRequests, fetchLatestActivity, markNotificationDone, unsubscribeNotification };
}

const defaultClient = createGitHubClient();

export async function fetchPullRequestReviewData(ref: PullRequestRef): Promise<PullRequestReviewData> {
  return defaultClient.fetchPullRequestReviewData(ref);
}

export async function compareCommits(ref: PullRequestRef, baseSha: string, headSha: string): Promise<{ files: PullFile[]; totalCommits: number }> {
  return defaultClient.compareCommits(ref, baseSha, headSha);
}

export async function fetchCommitChecks(ref: PullRequestRef, sha: string): Promise<CommitChecks> {
  return defaultClient.fetchCommitChecks(ref, sha);
}

export async function fetchFileText(ref: PullRequestRef, path: string, sha: string): Promise<string> {
  return defaultClient.fetchFileText(ref, path, sha);
}

export async function fetchPendingPullRequestReview(ref: PullRequestRef): Promise<GitHubPendingReviewLookup> {
  return defaultClient.fetchPendingPullRequestReview(ref);
}

export async function createPendingPullRequestReview(ref: PullRequestRef, pullRequestId: string): Promise<string> {
  return defaultClient.createPendingPullRequestReview(ref, pullRequestId);
}

export async function addPendingPullRequestReviewThread(ref: PullRequestRef, reviewId: string, comment: GitHubDraftCommentInput): Promise<void> {
  await defaultClient.addPendingPullRequestReviewThread(ref, reviewId, comment);
}

export async function submitPullRequestReview(ref: PullRequestRef, payload: unknown): Promise<unknown> {
  return defaultClient.submitPullRequestReview(ref, payload);
}

export async function replyToReviewComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
  return defaultClient.replyToReviewComment(ref, commentId, body);
}

export async function addIssueComment(ref: PullRequestRef, body: string): Promise<unknown> {
  return defaultClient.addIssueComment(ref, body);
}

export async function editReviewComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
  return defaultClient.editReviewComment(ref, commentId, body);
}

export async function editIssueComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
  return defaultClient.editIssueComment(ref, commentId, body);
}

export async function editReviewSummary(ref: PullRequestRef, reviewId: number, body: string): Promise<unknown> {
  return defaultClient.editReviewSummary(ref, reviewId, body);
}

export async function fetchViewerLogin(): Promise<string | null> {
  return defaultClient.fetchViewerLogin();
}

export async function fetchNotifications(): Promise<GitHubNotification[]> {
  return defaultClient.fetchNotifications();
}

export async function fetchSubjectSnapshots(refs: InboxSubjectRef[]): Promise<InboxSubjectSnapshot[]> {
  return defaultClient.fetchSubjectSnapshots(refs);
}

export async function fetchViewerPullRequests(login: string, scope: ViewerPullRequestScope): Promise<ViewerPullRequest[]> {
  return defaultClient.fetchViewerPullRequests(login, scope);
}

export async function fetchLatestActivity(urls: string[], login: string | null): Promise<Map<string, InboxLatestActivity>> {
  return defaultClient.fetchLatestActivity(urls, login);
}

export async function markNotificationDone(threadId: string): Promise<void> {
  await defaultClient.markNotificationDone(threadId);
}

export async function unsubscribeNotification(threadId: string): Promise<void> {
  await defaultClient.unsubscribeNotification(threadId);
}
