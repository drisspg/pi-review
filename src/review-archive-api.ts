import { refFromBody } from "./http.js";
import { prKey } from "./pr.js";
import { reviewSubmitMemoryRecord } from "./review-memory-api.js";
import type { DraftReview, PullRequestRef, PullRequestReviewData, ReviewMemoryRecord, StoredPullRequest } from "./types.js";

export type ReviewArchiveApiDeps = {
  clearDraftReview: (prKey: string) => Promise<void>;
  listArchivedReviews: (prKey: string) => Promise<ReviewMemoryRecord[]>;
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  markPullRequestReviewed: (prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]) => Promise<StoredPullRequest | null>;
  refFromBody: (body: unknown) => PullRequestRef;
  saveReviewMemory: (record: Omit<ReviewMemoryRecord, "id" | "createdAt">) => Promise<ReviewMemoryRecord>;
  /** Tell open review pages the drafts are gone, so archiving from a terminal (pr-takeover) cannot be undone by a stale page's autosave. */
  notifyDraftReview?: (prKey: string, draftReview: DraftReview) => Promise<void>;
};

export type ReviewArchiveApi = ReturnType<typeof createReviewArchiveApi>;

export const defaultReviewArchiveApiDeps = (deps: Omit<ReviewArchiveApiDeps, "refFromBody">): ReviewArchiveApiDeps => ({ ...deps, refFromBody });

export type ArchivedReviewSummary = Pick<ReviewMemoryRecord, "id" | "headSha" | "createdAt" | "event"> & { commentCount: number; summary: string };
export type ArchiveHistoryResponse = { archives: ArchivedReviewSummary[]; nextOffset: number | null } | { archive: ReviewMemoryRecord };

/** Save and retrieve local review snapshots without publishing or restoring drafts. */
export function createReviewArchiveApi(deps: ReviewArchiveApiDeps) {
  /** Only reviews with feedback (a body or a nonblank inline comment) are stored; empty ones still finish the review. */
  async function archive(payload: Record<string, unknown>): Promise<{ memory: ReviewMemoryRecord | null }> {
    const ref = deps.refFromBody(payload);
    const key = prKey(ref);
    const reviewData = await deps.fetchPullRequestReviewData(ref);
    const record = reviewSubmitMemoryRecord(payload, reviewData, key);
    const hasFeedback = record.body.length > 0 || record.comments.length > 0;
    const memory = hasFeedback ? await deps.saveReviewMemory({ ...record, disposition: "archived" }) : null;
    // An archived review still means "I finished looking at this head" — record it so re-opens offer the interdiff.
    await deps.markPullRequestReviewed(key, reviewData.pr.headSha, record.event);
    await deps.clearDraftReview(key);
    await deps.notifyDraftReview?.(key, { prKey: key, headSha: reviewData.pr.headSha, event: "COMMENT", body: "", comments: [], updatedAt: new Date().toISOString() });
    return { memory };
  }

  /** List compact PR-scoped history; retrieve original feedback only when explicitly requested. */
  async function history(payload: Record<string, unknown>): Promise<ArchiveHistoryResponse> {
    if (typeof payload.prKey !== "string" || !payload.prKey.trim()) throw new Error("Expected prKey");
    if (payload.archiveId !== undefined && (typeof payload.archiveId !== "string" || !payload.archiveId.trim())) throw new Error("Expected archiveId");
    const offset = payload.offset ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Expected a nonnegative integer offset");
    const records = await deps.listArchivedReviews(payload.prKey);
    if (typeof payload.archiveId === "string") {
      const record = records.find((record) => record.id === payload.archiveId);
      if (record == null) throw new Error("Archived feedback not found for this pull request");
      return { archive: record };
    }
    const page = records.slice(offset, offset + 20);
    return {
      archives: page.map((record) => ({ id: record.id, headSha: record.headSha, createdAt: record.createdAt, event: record.event, commentCount: record.comments.length, summary: record.body.slice(0, 300) })),
      nextOffset: offset + page.length < records.length ? offset + page.length : null,
    };
  }

  return { archive, history };
}
