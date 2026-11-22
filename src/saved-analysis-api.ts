import { sameReviewPair } from "./analysis-types.js";
import { parseFocusAreas } from "./focus.js";
import type { StateStore } from "./state.js";
import type { AiReviewMessageRecord, AiReviewRecord, FocusAreaReviewState, FocusScanRecord, GuideReviewRecord } from "./types.js";

export type SavedAnalysisApiDeps = {
  updateFocusScanProgress: StateStore["updateFocusScanProgress"];
  updateGuideReviewProgress: StateStore["updateGuideReviewProgress"];
  saveAiReview: (review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>) => Promise<AiReviewRecord>;
  saveFocusScan: (scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>) => Promise<FocusScanRecord>;
  saveOverview: (record: Omit<GuideReviewRecord, "id" | "createdAt" | "updatedAt" | "stepStates">) => Promise<GuideReviewRecord>;
  saveGuideReview: (review: Omit<GuideReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<GuideReviewRecord, "id" | "createdAt">>) => Promise<GuideReviewRecord>;
  listFocusScans: StateStore["listFocusScans"];
  listAiReviews: (prKey: string) => Promise<AiReviewRecord[]>;
};

/** The saved Pi "General review" text, without follow-up chat, for agents that validate it. */
export type GeneralReviewSnapshot = { id: string; headSha: string; createdAt: string; matchesHead: boolean | null; text: string };

export type SavedAnalysisApi = {
  updateFocusScanProgress: (payload: Record<string, unknown>) => Promise<{ scan: FocusScanRecord }>;
  updateGuideReviewProgress: (payload: Record<string, unknown>) => Promise<{ guide: GuideReviewRecord }>;
  saveFocusScan: (payload: Record<string, unknown>) => Promise<{ scan: FocusScanRecord }>;
  saveAiReview: (payload: Record<string, unknown>) => Promise<{ review: AiReviewRecord }>;
  saveGuideReview: (payload: Record<string, unknown>) => Promise<{ guide: GuideReviewRecord }>;
  saveOverview: (payload: Record<string, unknown>) => Promise<{ overview: GuideReviewRecord }>;
  readGeneralReview: (payload: Record<string, unknown>) => Promise<{ review: GeneralReviewSnapshot | null; olderCount: number }>;
};

function focusAreaStatesFromPayload(payload: Record<string, unknown>): Record<string, FocusAreaReviewState> {
  if (typeof payload.areaStates !== "object" || payload.areaStates == null || Array.isArray(payload.areaStates)) throw new Error("Expected focus scan payload");
  return payload.areaStates as Record<string, FocusAreaReviewState>;
}

function aiReviewMessagesFromPayload(payload: Record<string, unknown>): AiReviewMessageRecord[] | undefined {
  return Array.isArray(payload.messages) ? payload.messages as AiReviewMessageRecord[] : undefined;
}

function generalReviewText(review: AiReviewRecord): string {
  const general = review.messages?.filter((message) => message.kind === "general-review" && message.text.trim().length > 0).map((message) => message.text.trim()) ?? [];
  return general.length > 0 ? general.join("\n\n") : review.answer.trim();
}

function openFocusEvidence(scan: FocusScanRecord | undefined): string {
  if (!scan) return "Paired evidence is no longer available.";
  const areas = parseFocusAreas(scan.answer);
  if (!areas.length) return scan.answer;
  return areas.filter(area => !scan.areaStates[area.id]?.viewed).map(area => `- ${area.path}:${area.startLine}-${area.endLine} — ${area.title}
${area.body}`.trimEnd()).join("\n\n") || "The reviewer marked all inline findings handled.";
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

  /** Prefer the review for the caller's head; otherwise return the newest one and say it is stale. */
  async function readGeneralReview(payload: Record<string, unknown>): Promise<{ review: GeneralReviewSnapshot | null; olderCount: number }> {
    if (typeof payload.prKey !== "string") throw new Error("Expected prKey");
    const headSha = typeof payload.headSha === "string" && payload.headSha.length > 0 ? payload.headSha : null;
    const reviews = (await deps.listAiReviews(payload.prKey)).filter((review) => generalReviewText(review).length > 0);
    const record = reviews.find((review) => review.headSha === headSha) ?? reviews[0];
    if (record == null) return { review: null, olderCount: 0 };
    let text = generalReviewText(record);
    if (record.provenance?.reviewPairId) {
      const scan = (await deps.listFocusScans(payload.prKey)).find(candidate => sameReviewPair(record, candidate));
      text += "\n\n" + openFocusEvidence(scan);
    }
    return {
      review: { id: record.id, headSha: record.headSha, createdAt: record.createdAt, matchesHead: headSha == null ? null : record.headSha === headSha, text },
      olderCount: reviews.length - 1,
    };
  }

  return { updateFocusScanProgress, updateGuideReviewProgress, saveFocusScan, saveAiReview, saveGuideReview, saveOverview, readGeneralReview };
}
