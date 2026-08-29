import { refFromBody } from "./http.js";
import { prKey } from "./pr.js";
import { reviewSubmitMemoryRecord } from "./review-memory-api.js";
import type { PullRequestRef, PullRequestReviewData, ReviewMemoryRecord } from "./types.js";

export type ReviewArchiveApiDeps = {
  clearDraftReview: (prKey: string) => Promise<void>;
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  refFromBody: (body: unknown) => PullRequestRef;
  saveReviewMemory: (record: Omit<ReviewMemoryRecord, "id" | "createdAt">) => Promise<ReviewMemoryRecord>;
};

export type ReviewArchiveApi = ReturnType<typeof createReviewArchiveApi>;

export const defaultReviewArchiveApiDeps = (deps: Omit<ReviewArchiveApiDeps, "refFromBody">): ReviewArchiveApiDeps => ({ ...deps, refFromBody });

/** Save a complete local review snapshot without publishing it to GitHub. */
export function createReviewArchiveApi(deps: ReviewArchiveApiDeps) {
  async function archive(payload: Record<string, unknown>): Promise<{ memory: ReviewMemoryRecord }> {
    const ref = deps.refFromBody(payload);
    const key = prKey(ref);
    const reviewData = await deps.fetchPullRequestReviewData(ref);
    const memory = await deps.saveReviewMemory({ ...reviewSubmitMemoryRecord(payload, reviewData, key), disposition: "archived" });
    await deps.clearDraftReview(key);
    return { memory };
  }

  return { archive };
}
