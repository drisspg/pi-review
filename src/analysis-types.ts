import type { FocusArea } from "./focus.js";
import type { GuideChapter } from "./guide.js";
import type { AiReviewRecord, FocusScanRecord, GuideReviewRecord } from "./types.js";

export const ANALYSIS_VERSION = 1;
export type AnalysisKind = "main-review" | "focus-review" | "guide-review" | "code-walk";

export type AnalysisProvenance = {
  runId: string;
  version: number;
  model: string;
  thinkingLevel: string;
};

export type AnalysisResult =
  | { kind: "main-review"; record: AiReviewRecord }
  | { kind: "focus-review"; record: FocusScanRecord; areas: FocusArea[] }
  | { kind: "guide-review"; record: GuideReviewRecord; chapters: GuideChapter[] }
  | { kind: "code-walk"; record: GuideReviewRecord };

export type AnalysisRun = {
  id: string;
  prKey: string;
  headSha: string;
  kind: AnalysisKind;
  status: "running" | "complete" | "failed" | "invalid" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  result?: AnalysisResult;
  error?: string;
  rawAnswer?: string;
  activity?: import("./pi-session.js").PiActivity;
};
