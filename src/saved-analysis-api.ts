import type { StateStore } from "./state.js";
import type { AiReviewMessageRecord, AiReviewRecord, FocusAreaReviewState, FocusScanRecord, GuideReviewRecord } from "./types.js";

export type SavedAnalysisApiDeps = {
  updateFocusScanProgress: StateStore["updateFocusScanProgress"];
  updateGuideReviewProgress: StateStore["updateGuideReviewProgress"];
  saveAiReview: (review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>) => Promise<AiReviewRecord>;
  saveFocusScan: (scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>) => Promise<FocusScanRecord>;
  saveOverview: (record: Omit<GuideReviewRecord, "id" | "createdAt" | "updatedAt" | "stepStates">) => Promise<GuideReviewRecord>;
  saveGuideReview: (review: Omit<GuideReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<GuideReviewRecord, "id" | "createdAt">>) => Promise<GuideReviewRecord>;
};

export type SavedAnalysisApi = {
  updateFocusScanProgress: (payload: Record<string, unknown>) => Promise<{ scan: FocusScanRecord }>;
  updateGuideReviewProgress: (payload: Record<string, unknown>) => Promise<{ guide: GuideReviewRecord }>;
  saveFocusScan: (payload: Record<string, unknown>) => Promise<{ scan: FocusScanRecord }>;
  saveAiReview: (payload: Record<string, unknown>) => Promise<{ review: AiReviewRecord }>;
  saveGuideReview: (payload: Record<string, unknown>) => Promise<{ guide: GuideReviewRecord }>;
  saveOverview: (payload: Record<string, unknown>) => Promise<{ overview: GuideReviewRecord }>;
};

function focusAreaStatesFromPayload(payload: Record<string, unknown>): Record<string, FocusAreaReviewState> {
  if (typeof payload.areaStates !== "object" || payload.areaStates == null || Array.isArray(payload.areaStates)) throw new Error("Expected focus scan payload");
  return payload.areaStates as Record<string, FocusAreaReviewState>;
}

function aiReviewMessagesFromPayload(payload: Record<string, unknown>): AiReviewMessageRecord[] | undefined {
  return Array.isArray(payload.messages) ? payload.messages as AiReviewMessageRecord[] : undefined;
}

export function createSavedAnalysisApi(deps: SavedAnalysisApiDeps): SavedAnalysisApi {
  /** Accept identity and progress only; never forward artifact content from the caller. */
  async function updateFocusScanProgress(payload: Record<string, unknown>): Promise<{ scan: FocusScanRecord }> {
    if (typeof payload.prKey !== "string" || typeof payload.id !== "string") throw new Error("Expected focus progress payload");
    return { scan: await deps.updateFocusScanProgress({ prKey: payload.prKey, id: payload.id, areaStates: focusAreaStatesFromPayload(payload) }) };
  }

  /** Accept identity and progress only; never forward artifact content from the caller. */
  async function updateGuideReviewProgress(payload: Record<string, unknown>): Promise<{ guide: GuideReviewRecord }> {
    if (typeof payload.prKey !== "string" || typeof payload.id !== "string" || payload.stepStates == null || typeof payload.stepStates !== "object" || Array.isArray(payload.stepStates)) throw new Error("Expected guide progress payload");
    return { guide: await deps.updateGuideReviewProgress({ prKey: payload.prKey, id: payload.id, stepStates: payload.stepStates as NonNullable<GuideReviewRecord["stepStates"]> }) };
  }

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

  async function saveOverview(payload: Record<string, unknown>): Promise<{ overview: GuideReviewRecord }> {
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || typeof payload.answer !== "string") throw new Error("Expected overview payload");
    return { overview: await deps.saveOverview({ prKey: payload.prKey, headSha: payload.headSha, answer: payload.answer }) };
  }

  async function saveGuideReview(payload: Record<string, unknown>): Promise<{ guide: GuideReviewRecord }> {
    if (typeof payload.prKey !== "string" || typeof payload.headSha !== "string" || typeof payload.answer !== "string") throw new Error("Expected guide review payload");
    const record: Parameters<SavedAnalysisApiDeps["saveGuideReview"]>[0] = { prKey: payload.prKey, headSha: payload.headSha, answer: payload.answer };
    if (typeof payload.id === "string") record.id = payload.id;
    if (payload.stepStates != null) {
      if (typeof payload.stepStates !== "object" || Array.isArray(payload.stepStates)) throw new Error("Expected guide review payload");
      record.stepStates = payload.stepStates as GuideReviewRecord["stepStates"];
    }
    return { guide: await deps.saveGuideReview(record) };
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

  return { updateFocusScanProgress, updateGuideReviewProgress, saveFocusScan, saveAiReview, saveGuideReview, saveOverview };
}
