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

  async function addComment(payload: Record<string, unknown>): Promise<{ review: GitHubPendingReview }> {
    const ref = githubRef(payload, deps.refFromBody);
    const comment = commentFromPayload(payload);
    const pending = await deps.fetchPendingPullRequestReview(ref);
    const reviewId = pending.review?.id ?? await deps.createPendingPullRequestReview(ref, pending.pullRequestId);
    await deps.addPendingPullRequestReviewThread(ref, reviewId, comment);
    const { review } = await deps.fetchPendingPullRequestReview(ref);
    if (review == null) throw new Error("GitHub did not return the pending review after saving the comment");
    return { review };
  }

  return { addComment, pull };
}
