import { refFromBody } from "./http.js";
import type { PullRequestRef } from "./types.js";

export type CommentApiDeps = {
  addIssueComment: (ref: PullRequestRef, body: string) => Promise<unknown>;
  editIssueComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
  editReviewSummary: (ref: PullRequestRef, reviewId: number, body: string) => Promise<unknown>;
  refFromBody: (body: unknown) => PullRequestRef;
  replyToReviewComment: (ref: PullRequestRef, commentId: number, body: string) => Promise<unknown>;
};

export type CommentApi = {
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

  return { reply, edit };
}
