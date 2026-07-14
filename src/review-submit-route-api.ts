import { prKeyForRef, refFromBody } from "./http.js";
import { reviewSubmitMemoryRecord } from "./review-memory-api.js";
import { githubReviewComments, reviewSubmitCommentsFromPayload, reviewSubmitFailureMessage } from "./review-submit-api.js";
import type { PullRequestRef, PullRequestReviewData, ReviewMemoryRecord, StoredPullRequest } from "./types.js";

export type ReviewSubmitRouteApiDeps = {
  clearDraftReview: (prKey: string) => Promise<void>;
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  markPullRequestReviewed: (prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]) => Promise<StoredPullRequest | null>;
  refFromBody: (body: unknown) => PullRequestRef;
  saveReviewMemory: (record: Omit<ReviewMemoryRecord, "id" | "createdAt">) => Promise<ReviewMemoryRecord>;
  submitPullRequestReview: (ref: PullRequestRef, payload: unknown) => Promise<unknown>;
};

export type ReviewSubmitRouteApi = {
  submit: (payload: Record<string, unknown>) => Promise<{ result: unknown; pr: StoredPullRequest | null }>;
};

export const defaultReviewSubmitRouteApiDeps = (deps: Omit<ReviewSubmitRouteApiDeps, "refFromBody">): ReviewSubmitRouteApiDeps => ({ ...deps, refFromBody });

export function createReviewSubmitRouteApi(deps: ReviewSubmitRouteApiDeps): ReviewSubmitRouteApi {
  async function submit(payload: Record<string, unknown>): Promise<{ result: unknown; pr: StoredPullRequest | null }> {
    const ref = deps.refFromBody(payload);
    if (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") throw new Error("Expected review event");
    const comments = reviewSubmitCommentsFromPayload(payload.comments);
    let result: unknown;
    try {
      result = await deps.submitPullRequestReview(ref, { event: payload.event, body: payload.body, comments: githubReviewComments(comments) });
    } catch (error) {
      throw new Error(reviewSubmitFailureMessage(error, comments));
    }
    const prKey = prKeyForRef(ref);
    await deps.clearDraftReview(prKey);
    const reviewData = await deps.fetchPullRequestReviewData(ref);
    await deps.saveReviewMemory(reviewSubmitMemoryRecord(payload, reviewData, prKey));
    return { result, pr: await deps.markPullRequestReviewed(prKey, typeof payload.headSha === "string" ? payload.headSha : "", payload.event) };
  }

  return { submit };
}
