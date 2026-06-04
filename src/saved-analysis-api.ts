import type { AiReviewMessageRecord, AiReviewRecord, FocusAreaReviewState, FocusScanRecord } from "./types.js";

export type SavedAnalysisApiDeps = {
  saveAiReview: (review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>) => Promise<AiReviewRecord>;
  saveFocusScan: (scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>) => Promise<FocusScanRecord>;
};

export type SavedAnalysisApi = {
  saveFocusScan: (payload: Record<string, unknown>) => Promise<{ scan: FocusScanRecord }>;
  saveAiReview: (payload: Record<string, unknown>) => Promise<{ review: AiReviewRecord }>;
};

function focusAreaStatesFromPayload(payload: Record<string, unknown>): Record<string, FocusAreaReviewState> {
  if (typeof payload.areaStates !== "object" || payload.areaStates == null || Array.isArray(payload.areaStates)) throw new Error("Expected focus scan payload");
  return payload.areaStates as Record<string, FocusAreaReviewState>;
}

function aiReviewMessagesFromPayload(payload: Record<string, unknown>): AiReviewMessageRecord[] | undefined {
  return Array.isArray(payload.messages) ? payload.messages as AiReviewMessageRecord[] : undefined;
}

export function createSavedAnalysisApi(deps: SavedAnalysisApiDeps): SavedAnalysisApi {
  async function saveFocusScan(payload: Record<string, unknown>): Promise<{ scan: FocusScanRecord }> {
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || typeof payload.answer !== "string") throw new Error("Expected focus scan payload");
    return {
      scan: await deps.saveFocusScan({
        id: typeof payload.id === "string" ? payload.id : undefined,
        prKey: payload.prKey,
        headSha: payload.headSha,
        answer: payload.answer,
        areaStates: focusAreaStatesFromPayload(payload),
      }),
    };
  }

  async function saveAiReview(payload: Record<string, unknown>): Promise<{ review: AiReviewRecord }> {
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || typeof payload.answer !== "string") throw new Error("Expected AI review payload");
    return {
      review: await deps.saveAiReview({
        id: typeof payload.id === "string" ? payload.id : undefined,
        prKey: payload.prKey,
        headSha: payload.headSha,
        answer: payload.answer,
        messages: aiReviewMessagesFromPayload(payload),
      }),
    };
  }

  return { saveFocusScan, saveAiReview };
}
