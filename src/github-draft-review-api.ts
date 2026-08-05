import { refFromBody } from "./http.js";
import type { GitHubDraftCommentInput, GitHubPendingReview, GitHubPendingReviewLookup, PullRequestRef } from "./types.js";

export type GitHubDraftReviewApiDeps = {
  addPendingPullRequestReviewThread: (ref: PullRequestRef, reviewId: string, comment: GitHubDraftCommentInput) => Promise<void>;
  createPendingPullRequestReview: (ref: PullRequestRef, pullRequestId: string) => Promise<string>;
  fetchPendingPullRequestReview: (ref: PullRequestRef) => Promise<GitHubPendingReviewLookup>;
  refFromBody: (body: unknown) => PullRequestRef;
};

export type GitHubDraftReviewApi = {
  addComment: (payload: Record<string, unknown>) => Promise<{ review: GitHubPendingReview }>;
  addComments: (payload: Record<string, unknown>) => Promise<{ review: GitHubPendingReview }>;
  pull: (payload: Record<string, unknown>) => Promise<{ review: GitHubPendingReview | null }>;
};

export const defaultGitHubDraftReviewApiDeps = (deps: Omit<GitHubDraftReviewApiDeps, "refFromBody">): GitHubDraftReviewApiDeps => ({ ...deps, refFromBody });

function commentFromPayload(payload: Record<string, unknown>): GitHubDraftCommentInput {
  if (typeof payload.path !== "string" || payload.path.trim().length === 0) throw new Error("Expected comment path");
  if (typeof payload.body !== "string" || payload.body.trim().length === 0) throw new Error("Expected non-empty comment body");
  if (payload.line !== null && typeof payload.line !== "number") throw new Error("Expected comment line");
  if (payload.startLine !== undefined && payload.startLine !== null && typeof payload.startLine !== "number") throw new Error("Expected comment startLine");
  if (payload.line != null && payload.side !== "RIGHT" && payload.side !== "LEFT") throw new Error("Expected comment side");
  if (payload.line == null && payload.startLine != null) throw new Error("File comments cannot have startLine");
  return {
    path: payload.path.trim(),
    line: payload.line as number | null,
    startLine: payload.startLine as number | null | undefined,
    side: payload.line == null ? "RIGHT" : payload.side as "RIGHT" | "LEFT",
    body: payload.body.trim(),
  };
}

function commentsFromPayload(payload: Record<string, unknown>): GitHubDraftCommentInput[] {
  if (!Array.isArray(payload.comments) || payload.comments.length === 0) throw new Error("Expected private review comments");
  return payload.comments.map((comment) => {
    if (comment == null || typeof comment !== "object" || Array.isArray(comment)) throw new Error("Expected private review comment");
    return commentFromPayload(comment as Record<string, unknown>);
  });
}

function commentKey(comment: Pick<GitHubDraftCommentInput, "path" | "line" | "startLine" | "body">): string {
  return JSON.stringify([comment.path, comment.line, comment.startLine ?? null, comment.body.trim()]);
}

function githubRef(payload: Record<string, unknown>, parseRef: GitHubDraftReviewApiDeps["refFromBody"]): PullRequestRef {
  const ref = parseRef(payload);
  if (ref.host !== "github.com") throw new Error("Private GitHub drafts require a github.com pull request");
  return ref;
}

export function createGitHubDraftReviewApi(deps: GitHubDraftReviewApiDeps): GitHubDraftReviewApi {
  async function pull(payload: Record<string, unknown>): Promise<{ review: GitHubPendingReview | null }> {
    const { review } = await deps.fetchPendingPullRequestReview(githubRef(payload, deps.refFromBody));
    return { review };
  }

  async function addComments(payload: Record<string, unknown>): Promise<{ review: GitHubPendingReview }> {
    const ref = githubRef(payload, deps.refFromBody);
    const comments = commentsFromPayload(payload);
    const pending = await deps.fetchPendingPullRequestReview(ref);
    const existingCounts = new Map<string, number>();
    for (const comment of pending.review?.comments ?? []) {
      const key = commentKey(comment);
      existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
    }
    const commentsToAdd = comments.filter((comment) => {
      const key = commentKey(comment);
      const count = existingCounts.get(key) ?? 0;
      if (count === 0) return true;
      existingCounts.set(key, count - 1);
      return false;
    });
    if (commentsToAdd.length > 0) {
      const reviewId = pending.review?.id ?? await deps.createPendingPullRequestReview(ref, pending.pullRequestId);
      for (const comment of commentsToAdd) await deps.addPendingPullRequestReviewThread(ref, reviewId, comment);
    }
    const { review } = await deps.fetchPendingPullRequestReview(ref);
    if (review == null) throw new Error("GitHub did not return the pending review after saving comments");
    return { review };
  }

  async function addComment(payload: Record<string, unknown>): Promise<{ review: GitHubPendingReview }> {
    return addComments({ ...payload, comments: [payload] });
  }

  return { addComment, addComments, pull };
}
