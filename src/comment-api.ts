import { refFromBody } from "./http.js";
import type { PullRequestRef } from "./types.js";

export type CommentApiDeps = {
  setReviewThreadResolved: (ref: PullRequestRef, threadId: string, resolved: boolean) => Promise<{ id: string; isResolved: boolean }>;
  addIssueComment: (ref: PullRequestRef, body: string) => Promise<unknown>;
  editIssueComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editReviewSummary: (ref: PullRequestRef, reviewId: number, body: string) => Promise<unknown>;
  refFromBody: (body: unknown) => PullRequestRef;
  replyToReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
};

export type CommentApi = {
  resolve: (payload: Record<string, unknown>) => Promise<{ result: { id: string; isResolved: boolean } }>;
  reply: (payload: Record<string, unknown>) => Promise<{ result: unknown }>;
  edit: (payload: Record<string, unknown>) => Promise<{ result: unknown }>;
};

export const defaultCommentApiDeps = (deps: Omit<CommentApiDeps, "refFromBody">): CommentApiDeps => ({ ...deps, refFromBody });

function nonEmptyBody(payload: Record<string, unknown>): string {
  if (typeof payload.body !== "string" || payload.body.trim().length === 0) throw new Error("Expected non-empty body");
  return payload.body.trim();
}

function commentIdFromPayload(payload: Record<string, unknown>): number {
  if (typeof payload.commentId !== "number") throw new Error("Expected commentId");
  return payload.commentId;
}

export function createCommentApi(deps: CommentApiDeps): CommentApi {
  async function reply(payload: Record<string, unknown>): Promise<{ result: unknown }> {
    const ref = deps.refFromBody(payload);
    const body = nonEmptyBody(payload);
    if (payload.kind === "issue") return { result: await deps.addIssueComment(ref, body) };
    return { result: await deps.replyToReviewComment(ref, commentIdFromPayload(payload), body) };
  }

  async function edit(payload: Record<string, unknown>): Promise<{ result: unknown }> {
    const ref = deps.refFromBody(payload);
    const commentId = commentIdFromPayload(payload);
    const body = nonEmptyBody(payload);
    if (payload.kind === "issue") return { result: await deps.editIssueComment(ref, commentId, body) };
    if (payload.kind === "review-summary") return { result: await deps.editReviewSummary(ref, commentId, body) };
    if (payload.kind !== "review") throw new Error("Expected comment kind");
    return { result: await deps.editReviewComment(ref, commentId, body) };
  }

  /** Set an explicit thread state; retrying a request never toggles it accidentally. */
  async function resolve(payload: Record<string, unknown>) {
    const ref = deps.refFromBody(payload);
    if (typeof payload.threadId !== "string" || !payload.threadId.trim()) throw new Error("Expected threadId");
    if (typeof payload.resolved !== "boolean") throw new Error("Expected resolved boolean");
    return { result: await deps.setReviewThreadResolved(ref, payload.threadId, payload.resolved) };
  }

  return { reply, edit, resolve };
}
