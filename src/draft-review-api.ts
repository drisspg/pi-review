import type { DraftReview, DraftReviewComment } from "./types.js";

export type DraftReviewApiDeps = {
  getDraftReview: (prKey: string) => Promise<DraftReview | null>;
  now: () => string;
  saveDraftReview: (review: DraftReview) => Promise<DraftReview>;
};

export type DraftReviewApi = {
  get: (payload: Record<string, unknown>) => Promise<{ draftReview: DraftReview | null }>;
  save: (payload: Record<string, unknown>) => Promise<{ draftReview: DraftReview }>;
};

function draftCommentFromPayload(value: unknown): DraftReviewComment {
  if (typeof value !== "object" || value == null) throw new Error("Expected draft comment");
  const comment = value as Record<string, unknown>;
  if (typeof comment.id !== "string" || typeof comment.path !== "string" || (comment.line !== null && typeof comment.line !== "number") || (comment.side !== "RIGHT" && comment.side !== "LEFT") || typeof comment.body !== "string") throw new Error("Expected draft comment fields");
  if (comment.startLine !== undefined && comment.startLine !== null && typeof comment.startLine !== "number") throw new Error("Expected draft startLine");
  return { id: comment.id, path: comment.path, line: comment.line, startLine: comment.startLine as number | null | undefined, side: comment.side, body: comment.body };
}

function draftReviewFromPayload(payload: Record<string, unknown>, updatedAt: string): DraftReview {
  if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") || typeof payload.body !== "string" || !Array.isArray(payload.comments)) throw new Error("Expected draft review payload");
  return { prKey: payload.prKey, headSha: payload.headSha, event: payload.event, body: payload.body, comments: payload.comments.map(draftCommentFromPayload), updatedAt };
}

export function createDraftReviewApi(deps: DraftReviewApiDeps): DraftReviewApi {
  async function get(payload: Record<string, unknown>): Promise<{ draftReview: DraftReview | null }> {
    if (typeof payload.prKey !== "string" || payload.prKey.trim().length === 0) throw new Error("Expected prKey");
    return { draftReview: await deps.getDraftReview(payload.prKey) };
  }

  async function save(payload: Record<string, unknown>): Promise<{ draftReview: DraftReview }> {
    return { draftReview: await deps.saveDraftReview(draftReviewFromPayload(payload, deps.now())) };
  }

  return { get, save };
}
