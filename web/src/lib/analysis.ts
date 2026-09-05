import { api } from "../api";
import type { AnalysisKind, AnalysisResult, AnalysisRun } from "../../../src/analysis-types";

export class AnalysisError extends Error {
  constructor(message: string, readonly rawAnswer?: string) { super(message); }
}

/** Poll a backend-owned run; navigation may stop observing without cancelling its persistence. */
export async function runAnalysis(prKey: string, headSha: string, kind: AnalysisKind, force: boolean, onActivity: (activity: AnalysisRun["activity"]) => void, isCurrent: () => boolean): Promise<AnalysisResult | null> {
  let { run } = await api<{ run: AnalysisRun }>("/api/analysis/start", { method: "POST", body: JSON.stringify({ prKey, headSha, kind, force }) });
  while (run.status === "running") {
    if (!isCurrent()) return null;
    onActivity(run.activity);
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (!isCurrent()) return null;
    ({ run } = await api<{ run: AnalysisRun }>("/api/analysis/status", { method: "POST", body: JSON.stringify({ runId: run.id }) }));
  }
  if (!isCurrent()) return null;
  if (run.status !== "complete" || run.result == null) throw new AnalysisError(run.error ?? "Analysis did not complete.", run.rawAnswer);
  if (run.prKey !== prKey || run.headSha !== headSha || run.result.kind !== kind || run.result.record.headSha !== headSha) throw new AnalysisError("Analysis returned a different PR revision.");
  return run.result;
}
