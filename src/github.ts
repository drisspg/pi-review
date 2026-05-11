import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { logger } from "./logger.js";
import { prKey } from "./pr.js";
import { listFileReviews } from "./state.js";
import type { PullFile, PullIssueComment, PullRequest, PullRequestRef, PullRequestReviewData, PullRequestReviewDecision, PullReviewComment, StoredPullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

async function ghApi<T>(path: string): Promise<T> {
  const startedAt = performance.now();
  logger.info("github", "gh api start", { path });
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["api", path], { maxBuffer: 50 * 1024 * 1024 });
    logger.info("github", "gh api complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
    return JSON.parse(stdout) as T;
  } catch (error) {
    logger.error("github", "gh api failed", { path, ms: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function apiBase(ref: PullRequestRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

type ReviewThreadGraphql = { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ id: string; isResolved: boolean; comments?: { nodes?: Array<{ databaseId: number | null }> } }> } } } } };
type ReviewDecisionGraphql = { data?: { repository?: { pullRequest?: { reviewDecision?: PullRequestReviewDecision } } } };

async function fetchReviewDecision(ref: PullRequestRef): Promise<PullRequestReviewDecision> {
  if (ref.host !== "github.com") return null;
  const query = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision } } }`;
  try {
    const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${ref.owner}`, "-F", `repo=${ref.repo}`, "-F", `number=${ref.number}`], { maxBuffer: 50 * 1024 * 1024 });
    return (JSON.parse(stdout) as ReviewDecisionGraphql).data?.repository?.pullRequest?.reviewDecision ?? null;
  } catch (error) {
    logger.warn("github", "fetch review decision failed", { ref, error: error instanceof Error ? error.message : String(error) });
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
    ({ stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${ref.owner}`, "-F", `repo=${ref.repo}`, "-F", `number=${ref.number}`], { maxBuffer: 50 * 1024 * 1024 }));
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

function toStoredPullRequest(ref: PullRequestRef, pr: PullRequest, files: PullFile[], comments: PullReviewComment[], issueComments: PullIssueComment[], reviewDecision: PullRequestReviewDecision): StoredPullRequest {
  return {
    key: prKey(ref),
    ref,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.state,
    author: pr.user?.login ?? null,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    filesChanged: files.length,
    existingCommentCount: comments.length + issueComments.length,
    lastOpenedAt: new Date().toISOString(),
    lastReviewedHeadSha: null,
    lastReviewEvent: null,
    reviewDecision,
  };
}

function fileFingerprint(file: PullFile): string {
  return createHash("sha1").update(`${file.status}\n${file.previous_filename ?? ""}\n${file.patch ?? ""}`).digest("hex");
}

export async function fetchPullRequestReviewData(ref: PullRequestRef): Promise<PullRequestReviewData> {
  logger.info("github", "fetch PR review data", { ref });
  const [rawPr, files, rawComments, issueComments, threadStates, reviewDecision] = await Promise.all([
    ghApi<PullRequest>(apiBase(ref)),
    ghApi<PullFile[]>(`${apiBase(ref)}/files`),
    ghApi<PullReviewComment[]>(`${apiBase(ref)}/comments`),
    ghApi<PullIssueComment[]>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`),
    fetchReviewThreadStates(ref),
    fetchReviewDecision(ref),
  ]);
  const comments = rawComments.map((comment) => ({ ...comment, ...threadStates.get(comment.id) }));
  const pr = toStoredPullRequest(ref, rawPr, files, comments, issueComments, reviewDecision);
  logger.info("github", "fetched PR review data", { key: pr.key, title: pr.title, files: files.length, reviewComments: comments.length, issueComments: issueComments.length });
  const storedFileReviews = await listFileReviews(pr.key);
  const fileReviews = files.map((file) => {
    const fingerprint = fileFingerprint(file);
    return storedFileReviews.find((review) => review.path === file.filename && review.fingerprint === fingerprint) ?? {
      prKey: pr.key,
      path: file.filename,
      fingerprint,
      viewed: false,
      updatedAt: new Date().toISOString(),
    };
  });
  return { pr, raw: rawPr, files, comments, issueComments, fileReviews };
}

export function fingerprintPullFile(file: PullFile): string {
  return fileFingerprint(file);
}

export async function fetchFileText(ref: PullRequestRef, path: string, sha: string): Promise<string> {
  const endpoint = `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${sha}`;
  const startedAt = performance.now();
  logger.info("github", "fetch file text start", { path, sha: sha.slice(0, 12) });
  const { stdout } = await execFileAsync("gh", ["api", endpoint, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 50 * 1024 * 1024 });
  logger.info("github", "fetch file text complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length });
  return stdout.replace(/\r\n/g, "\n");
}

async function ghApiWrite(ref: PullRequestRef, method: "POST" | "PATCH", path: string, payload: unknown, scope: string): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-"));
  const inputPath = join(dir, "payload.json");
  await writeFile(inputPath, JSON.stringify(payload), "utf8");
  const startedAt = performance.now();
  logger.info("github", `${scope} start`, { ref });
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["api", path, "--method", method, "--input", inputPath], { maxBuffer: 50 * 1024 * 1024 });
    logger.info("github", `${scope} complete`, { ref, ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    logger.error("github", `${scope} failed`, { ref, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ghApiPost(ref: PullRequestRef, path: string, payload: unknown, scope: string): Promise<unknown> {
  return ghApiWrite(ref, "POST", path, payload, scope);
}

async function ghApiPatch(ref: PullRequestRef, path: string, payload: unknown, scope: string): Promise<unknown> {
  return ghApiWrite(ref, "PATCH", path, payload, scope);
}

export async function submitPullRequestReview(ref: PullRequestRef, payload: unknown): Promise<unknown> {
  return ghApiPost(ref, apiBase(ref) + "/reviews", payload, "submit review");
}

export async function replyToReviewComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
  return ghApiPost(ref, `${apiBase(ref)}/comments/${commentId}/replies`, { body }, "reply review comment");
}

export async function addIssueComment(ref: PullRequestRef, body: string): Promise<unknown> {
  return ghApiPost(ref, `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body }, "add issue comment");
}

export async function editReviewComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
  return ghApiPatch(ref, `/repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`, { body }, "edit review comment");
}

export async function editIssueComment(ref: PullRequestRef, commentId: number, body: string): Promise<unknown> {
  return ghApiPatch(ref, `/repos/${ref.owner}/${ref.repo}/issues/comments/${commentId}`, { body }, "edit issue comment");
}

export async function fetchPullRequestSummary(ref: PullRequestRef): Promise<StoredPullRequest> {
  return (await fetchPullRequestReviewData(ref)).pr;
}
