import { api } from "../api";
import { sameReviewPair, type AnalysisKind, type AnalysisResult, type AnalysisRun } from "../../../src/analysis-types";
export { sameReviewPair } from "../../../src/analysis-types";

export class AnalysisError extends Error {
  constructor(message: string, readonly rawAnswer?: string) { super(message); }
}

/** Wait between status polls: slower while the tab is hidden, cut short when the user returns to it. */
function pollDelay(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => { if (!document.hidden) done(); };
    const timer = setTimeout(done, document.hidden ? 10_000 : 2_000);
    document.addEventListener("visibilitychange", onVisible);
  });
}

/** Poll a backend-owned run; navigation may stop observing without cancelling its persistence. */
export async function runAnalysis(prKey: string, headSha: string, kind: AnalysisKind, force: boolean, onActivity: (activity: AnalysisRun["activity"]) => void, isCurrent: () => boolean): Promise<AnalysisResult[] | null> {
  let { run } = await api<{ run: AnalysisRun }>("/api/analysis/start", { method: "POST", body: JSON.stringify({ prKey, headSha, kind, force }) });
  while (run.status === "running") {
    if (!isCurrent()) return null;
    onActivity(run.activity);
    await pollDelay();
    if (!isCurrent()) return null;
    ({ run } = await api<{ run: AnalysisRun }>("/api/analysis/status", { method: "POST", body: JSON.stringify({ runId: run.id }) }));
  }
  if (!isCurrent()) return null;
  if (run.status !== "complete" || run.result == null) throw new AnalysisError(run.error ?? "Analysis did not complete.", run.rawAnswer);
  if (run.prKey !== prKey || run.headSha !== headSha || run.result.kind !== kind || run.result.record.prKey !== prKey || run.result.record.headSha !== headSha) throw new AnalysisError("Analysis returned a different PR revision.");
  if (run.companion == null) {
    if (run.result.record.provenance?.reviewPairId != null) throw new AnalysisError("Analysis returned only half of a paired review.");
    return [run.result];
  }
  const companionKind = kind === "main-review" ? "focus-review" : kind === "focus-review" ? "main-review" : null;
  if (run.companion.kind !== companionKind || !sameReviewPair(run.result.record, run.companion.record)) throw new AnalysisError("Analysis returned mismatched review artifacts.");
  return [run.result, run.companion];
}
