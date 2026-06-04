import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { logger } from "./logger.js";
import { prKey } from "./pr.js";
import { listFileReviews } from "./state.js";
import type { FileReviewState, PullFile, PullIssueComment, PullRequest, PullRequestRef, PullRequestReviewData, PullRequestReviewDecision, PullRequestReviewSummary, PullReviewComment, StoredPullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export type ExecFileOptions = { maxBuffer: number };

export type GitHubRuntime = {
  execFile: (command: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
  listFileReviews: (prKey: string) => Promise<FileReviewState[]>;
  mkdtemp: (prefix: string) => Promise<string>;
  rm: (path: string) => Promise<void>;
  now: () => string;
  writeFile: (path: string, data: string) => Promise<void>;
};

export type GitHubClient = {
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  fetchFileText: (ref: PullRequestRef, path: string, sha: string) => Promise<string>;
  submitPullRequestReview: (ref: PullRequestRef, payload: unknown) => Promise<unknown>;
  replyToReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  addIssueComment: (ref: PullRequestRef, body: string) => Promise<unknown>;
  editReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editIssueComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editReviewSummary: (ref: PullRequestRef, reviewId: number, body: string) => Promise<unknown>;
  fetchPullRequestSummary: (ref: PullRequestRef) => Promise<StoredPullRequest>;
};

const defaultRuntime: GitHubRuntime = {
  async execFile(command, args, options) {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return { stdout, stderr };
  },
  listFileReviews,
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

function apiBase(ref: PullRequestRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

function toStoredPullRequest(ref: PullRequestRef, pr: PullRequest, files: PullFile[], comments: PullReviewComment[], issueComments: PullIssueComment[], reviewSummaries: PullRequestReviewSummary[], reviewDecision: PullRequestReviewDecision, now: string): StoredPullRequest {
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
    existingCommentCount: comments.length + issueComments.length + reviewSummaries.length,
    lastOpenedAt: now,
    lastReviewedHeadSha: null,
    lastReviewEvent: null,
    reviewDecision,
  };
}

function fileFingerprint(file: PullFile): string {
  return createHash("sha1").update(`${file.status}\n${file.previous_filename ?? ""}\n${file.patch ?? ""}`).digest("hex");
}

export function fingerprintPullFile(file: PullFile): string {
  return fileFingerprint(file);
}

export function createGitHubClient(runtime: GitHubRuntime = defaultRuntime): GitHubClient {
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
    const [rawPr, files, rawComments, issueComments, rawReviewSummaries, threadStates, reviewDecision] = await Promise.all([
      ghApi<PullRequest>(apiBase(ref)),
      ghApi<PullFile[]>(`${apiBase(ref)}/files`),
      ghApi<PullReviewComment[]>(`${apiBase(ref)}/comments`),
      ghApi<PullIssueComment[]>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`),
      ghApi<PullRequestReviewSummary[]>(`${apiBase(ref)}/reviews`),
      fetchReviewThreadStates(ref),
      fetchReviewDecision(ref),
    ]);
    const comments = rawComments.map((comment) => ({ ...comment, ...threadStates.get(comment.id) }));
    const reviewSummaries = rawReviewSummaries.filter((review) => review.body.trim().length > 0);
    const pr = toStoredPullRequest(ref, rawPr, files, comments, issueComments, reviewSummaries, reviewDecision, runtime.now());
    logger.info("github", "fetched PR review data", { key: pr.key, title: pr.title, files: files.length, reviewComments: comments.length, issueComments: issueComments.length, reviewSummaries: reviewSummaries.length });
    const storedFileReviews = await runtime.listFileReviews(pr.key);
    const fileReviews = files.map((file) => {
      const fingerprint = fileFingerprint(file);
      return storedFileReviews.find((review) => review.path === file.filename && review.fingerprint === fingerprint) ?? {
        prKey: pr.key,
        path: file.filename,
        fingerprint,
        viewed: false,
        updatedAt: runtime.now(),
      };
    });
    return { pr, raw: rawPr, files, comments, issueComments, reviewSummaries, fileReviews };
  }

  async function fetchFileText(ref: PullRequestRef, path: string, sha: string): Promise<string> {
    const endpoint = `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${sha}`;
    const startedAt = performance.now();
    logger.info("github", "fetch file text start", { path, sha: sha.slice(0, 12) });
    const { stdout } = await runtime.execFile("gh", ["api", endpoint, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 50 * 1024 * 1024 });
    logger.info("github", "fetch file text complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length });
    return stdout.replace(/\r\n/g, "\n");
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

  async function fetchPullRequestSummary(ref: PullRequestRef): Promise<StoredPullRequest> {
    return (await fetchPullRequestReviewData(ref)).pr;
  }

  return { fetchPullRequestReviewData, fetchFileText, submitPullRequestReview, replyToReviewComment, addIssueComment, editReviewComment, editIssueComment, editReviewSummary, fetchPullRequestSummary };
}

const defaultClient = createGitHubClient();

export async function fetchPullRequestReviewData(ref: PullRequestRef): Promise<PullRequestReviewData> {
  return defaultClient.fetchPullRequestReviewData(ref);
}

export async function fetchFileText(ref: PullRequestRef, path: string, sha: string): Promise<string> {
  return defaultClient.fetchFileText(ref, path, sha);
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

export async function fetchPullRequestSummary(ref: PullRequestRef): Promise<StoredPullRequest> {
  return defaultClient.fetchPullRequestSummary(ref);
}
