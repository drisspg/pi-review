import { reviewMemoryChangeSet, reviewMemoryComments, reviewSubmitCommentsFromPayload } from "./review-submit-api.js";
import type { PullRequestReviewData, ReviewMemoryChangeSet, ReviewMemoryProfile, ReviewMemoryRecord } from "./types.js";

export type ReviewMemoryApiDeps = {
  askPi: (prKey: string, prompt: string, purpose?: string) => Promise<string>;
  currentReviewMemoryDistillationSource: () => Promise<string>;
  currentReviewMemoryPrompt: () => Promise<string>;
  currentReviewProfile: () => Promise<ReviewMemoryProfile | null>;
  fetchPullRequestReviewData?: (payload: Record<string, unknown>) => Promise<PullRequestReviewData>;
  listReviewMemoryRecords: (limit?: number) => Promise<ReviewMemoryRecord[]>;
  reviewMemoryStats: () => Promise<{ recordCount: number; inlineCommentCount: number; prCount: number; latestCreatedAt: string | null; profileUpdatedAt: string | null; profileSourceRecordCount: number | null }>;
  saveReviewMemory: (record: Omit<ReviewMemoryRecord, "id" | "createdAt">) => Promise<ReviewMemoryRecord>;
  saveReviewProfile: (text: string) => Promise<ReviewMemoryProfile>;
};

export type ReviewMemoryApi = {
  status: (limitInput?: string | null) => Promise<{ prompt: string; profile: ReviewMemoryProfile | null; records: ReviewMemoryRecord[]; stats: Awaited<ReturnType<ReviewMemoryApiDeps["reviewMemoryStats"]>> }>;
  capture: (payload: Record<string, unknown>) => Promise<{ memory: ReviewMemoryRecord }>;
  distill: () => Promise<{ profile: string }>;
};

function boundedReviewMemoryLimit(limitInput: string | null | undefined): number {
  const limit = Number.parseInt(limitInput ?? "50", 10);
  return Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50;
}

export function reviewMemoryCaptureRecord(payload: Record<string, unknown>): Omit<ReviewMemoryRecord, "id" | "createdAt"> {
  if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string") throw new Error("Expected prKey and headSha");
  if (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") throw new Error("Expected review event");
  return {
    prKey: payload.prKey,
    headSha: payload.headSha,
    event: payload.event,
    body: typeof payload.body === "string" ? payload.body.trim() : "",
    comments: reviewMemoryComments(reviewSubmitCommentsFromPayload(payload.comments)),
    changeSet: typeof payload.changeSet === "object" && payload.changeSet != null && !Array.isArray(payload.changeSet) ? payload.changeSet as ReviewMemoryChangeSet : undefined,
  };
}

export function createReviewMemoryApi(deps: ReviewMemoryApiDeps): ReviewMemoryApi {
  async function status(limitInput?: string | null): Promise<{ prompt: string; profile: ReviewMemoryProfile | null; records: ReviewMemoryRecord[]; stats: Awaited<ReturnType<ReviewMemoryApiDeps["reviewMemoryStats"]>> }> {
    return {
      prompt: await deps.currentReviewMemoryPrompt(),
      profile: await deps.currentReviewProfile(),
      records: await deps.listReviewMemoryRecords(boundedReviewMemoryLimit(limitInput)),
      stats: await deps.reviewMemoryStats(),
    };
  }

  async function capture(payload: Record<string, unknown>): Promise<{ memory: ReviewMemoryRecord }> {
    return { memory: await deps.saveReviewMemory(reviewMemoryCaptureRecord(payload)) };
  }

  async function distill(): Promise<{ profile: string }> {
    const existingProfile = await deps.currentReviewProfile();
    const source = await deps.currentReviewMemoryDistillationSource();
    const prompt = `Distill Driss's code-review preferences from raw submitted review comments into an actionable reviewer profile.

Return only markdown with these sections:
# Driss review profile
## What to flag
## What to usually ignore
## Severity calibration
## Comment style
## Review prompt rules

Make the profile compact and directive. Prefer durable patterns over one-off specifics. Include actionable rules a future reviewer can follow. Do not include raw examples verbatim except short representative phrases when needed.

Existing profile:
${existingProfile?.text ?? "No existing profile."}

Raw review evidence:
${source}`;
    return { profile: (await deps.saveReviewProfile(await deps.askPi("review-memory", prompt, "review-memory-distill"))).text };
  }

  return { status, capture, distill };
}

export function reviewSubmitMemoryRecord(payload: Record<string, unknown>, reviewData: PullRequestReviewData, prKey: string): Omit<ReviewMemoryRecord, "id" | "createdAt"> {
  if (payload.event !== "COMMENT" && payload.event !== "APPROVE" && payload.event !== "REQUEST_CHANGES") throw new Error("Expected review event");
  const comments = reviewMemoryComments(reviewSubmitCommentsFromPayload(payload.comments));
  return {
    prKey,
    headSha: typeof payload.headSha === "string" ? payload.headSha : "",
    event: payload.event,
    body: typeof payload.body === "string" ? payload.body.trim() : "",
    comments,
    changeSet: reviewMemoryChangeSet(reviewData, comments),
  };
}
