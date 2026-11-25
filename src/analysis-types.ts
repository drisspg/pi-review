import type { FocusArea } from "./focus.js";
import type { GuideChapter } from "./guide.js";
import type { AiReviewRecord, FocusScanRecord, GuideReviewRecord } from "./types.js";

export const ANALYSIS_VERSION = 1;
/** 2: the overview is a show-me HTML page instead of markdown panels; 3: it opens with a short lead. */
export const OVERVIEW_VERSION = 3;
export const REVIEW_PAIR_VERSION = 4;
export type AnalysisKind = "main-review" | "focus-review" | "guide-review" | "code-walk";

export type AnalysisProvenance = {
  runId: string;
  reviewPairId?: string;
  version: number;
  model: string;
  thinkingLevel: string;
};

export type AnalysisResult =
  | { kind: "main-review"; record: AiReviewRecord }
  | { kind: "focus-review"; record: FocusScanRecord; areas: FocusArea[] }
  | { kind: "guide-review"; record: GuideReviewRecord; chapters: GuideChapter[] }
  | { kind: "code-walk"; record: GuideReviewRecord };

export function sameReviewPair(a: AnalysisResult["record"] | undefined, b: AnalysisResult["record"] | undefined): boolean {
  return a?.provenance?.reviewPairId != null && a.provenance.reviewPairId === b?.provenance?.reviewPairId && a.prKey === b.prKey && a.headSha === b.headSha;
}

export type AnalysisRun = {
  id: string;
  prKey: string;
  headSha: string;
  kind: AnalysisKind;
  status: "running" | "complete" | "failed" | "invalid" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  result?: AnalysisResult;
  companion?: AnalysisResult;
  reviewStage?: "discovery" | "verification" | "synthesis";
  error?: string;
  rawAnswer?: string;
  activity?: import("./pi-session.js").PiActivity;
};
