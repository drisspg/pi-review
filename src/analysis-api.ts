import { randomUUID } from "node:crypto";

import { ANALYSIS_VERSION, type AnalysisKind, type AnalysisProvenance, type AnalysisResult, type AnalysisRun } from "./analysis-types.js";
import { focusReviewHasNoFindings, parseFocusAreas } from "./focus.js";
import { parseGuideChapters } from "./guide.js";
import { validateReviewDraftTarget, type ReviewDraftToolContext } from "./review-draft-tool.js";
import type { ReviewPromptApi } from "./review-prompt-api.js";
import type { SavedAnalysisApiDeps } from "./saved-analysis-api.js";
import type { AiReviewRecord, FocusScanRecord, GuideReviewRecord, StoredPullRequest } from "./types.js";

export type AnalysisApiDeps = Pick<SavedAnalysisApiDeps, "saveAiReview" | "saveFocusScan" | "saveGuideReview" | "saveOverview"> & {
  contextForPr: (prKey: string) => ReviewDraftToolContext | null;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  listAiReviews: (prKey: string) => Promise<AiReviewRecord[]>;
  listFocusScans: (prKey: string) => Promise<FocusScanRecord[]>;
  listGuideReviews: (prKey: string) => Promise<GuideReviewRecord[]>;
  listOverviews: (prKey: string) => Promise<GuideReviewRecord[]>;
  buildPrompt: ReviewPromptApi["build"];
  askPi: (prKey: string, prompt: string, purpose: string) => Promise<string>;
  modelForRun: (prKey: string, purpose: string) => Promise<{ model: string; thinkingLevel: string }>;
  activity?: (prKey: string, purpose: string) => Promise<NonNullable<AnalysisRun["activity"]>>;
  record?: (name: string, data: Record<string, unknown>) => void;
};

export type AnalysisApi = {
  start: (payload: Record<string, unknown>) => Promise<{ run: AnalysisRun }>;
  status: (payload: Record<string, unknown>) => Promise<{ run: AnalysisRun }>;
  invalidate: (prKey: string) => void;
};

class InvalidAnalysisError extends Error {}

/** Validate generated locations against the immutable diff before publishing a result. */
function validateLocations(context: ReviewDraftToolContext, areas: ReturnType<typeof parseFocusAreas>): void {
  for (const area of areas) {
    try {
      // Analysis connects locations; only a publishable GitHub comment needs one contiguous hunk.
      for (const line of new Set([area.startLine, area.endLine])) {
        validateReviewDraftTarget(context, { path: area.path, line, body: area.title });
      }
    } catch (error) {
      throw new InvalidAnalysisError(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Own analysis execution and persistence independently of any browser or selected PR. */
export function createAnalysisApi(deps: AnalysisApiDeps): AnalysisApi {
  const runs = new Map<string, AnalysisRun>();
  const active = new Map<string, AnalysisRun>();

  function invalidate(prKey: string): void {
    for (const [key, run] of active) {
      if (run.prKey !== prKey) continue;
      run.status = "cancelled";
      run.error = "The PR workspace changed while this analysis was running.";
      run.finishedAt = new Date().toISOString();
      active.delete(key);
    }
  }

  /** Explicit invalidation handles cleanup/reopen; same-HEAD metadata refreshes remain valid. */
  function isCurrent(run: AnalysisRun, context: ReviewDraftToolContext): boolean {
    return run.status === "running" && deps.contextForPr(run.prKey)?.headSha === context.headSha;
  }

  async function previousRecord(kind: AnalysisKind, prKey: string, headSha: string): Promise<AiReviewRecord | FocusScanRecord | GuideReviewRecord | undefined> {
    const records = await ({
      "main-review": deps.listAiReviews,
      "focus-review": deps.listFocusScans,
      "guide-review": deps.listGuideReviews,
      "code-walk": deps.listOverviews,
    }[kind])(prKey);
    return records.find((record) => record.headSha === headSha) ?? records[0];
  }

  /** Parse once on the server; malformed output never becomes a successful empty result. */
  function resultFor(kind: AnalysisKind, record: AiReviewRecord | FocusScanRecord | GuideReviewRecord, context: ReviewDraftToolContext): AnalysisResult {
    const answer = record.answer.trim();
    if (!answer || /^(?:Pi|AI review|Focus scan) completed without (?:assistant text|output)\.?$/i.test(answer)) throw new InvalidAnalysisError("Pi returned no final analysis.");
    if (kind === "focus-review") {
      const areas = parseFocusAreas(answer);
      if (areas.length === 0 && !focusReviewHasNoFindings(answer)) throw new InvalidAnalysisError("The focus scan did not return findings or an explicit clean result. See the raw response.");
      validateLocations(context, areas);
      return { kind, record: record as FocusScanRecord, areas };
    }
    if (kind === "guide-review") {
      const chapters = parseGuideChapters(answer);
      const chapterCount = [...answer.matchAll(/^###\s+.+$/gm)].length;
      if (chapters.length === 0 || chapters.length !== chapterCount) throw new InvalidAnalysisError("The walkthrough contains missing or invalid review stops. See the raw response.");
      validateLocations(context, chapters.flatMap((chapter) => chapter.steps));
      return { kind, record, chapters };
    }
    if (kind === "code-walk" && ![/^## TL;DR\s*$/m, /^## Schematic\s*$/m, /^## Change map\s*$/m, /^## Reviewer notes\s*$/m].every((heading) => heading.test(answer))) {
      throw new InvalidAnalysisError("The overview is missing required sections. See the raw response.");
    }
    return { kind, record };
  }

  async function execute(run: AnalysisRun, context: ReviewDraftToolContext, force: boolean): Promise<void> {
    try {
      const [previous, prs] = await Promise.all([previousRecord(run.kind, run.prKey, run.headSha), deps.listRecentPullRequests()]);
      if (!isCurrent(run, context)) return;
      if (!force && previous?.headSha === run.headSha && previous.provenance?.version === ANALYSIS_VERSION) {
        run.result = resultFor(run.kind, previous, context);
      } else {
        const { prompt, purpose } = await deps.buildPrompt({
          mode: run.kind,
          prKey: run.prKey,
          prTitle: prs.find((pr) => pr.key === run.prKey)?.title ?? run.prKey,
          files: context.files,
          // Prior findings are context, not evidence that an issue has been resolved.
          ...(run.kind === "main-review" ? { previousAiReview: previous?.answer } : {}),
          ...(run.kind === "focus-review" ? { previousFocusAreas: previous?.answer } : {}),
        });
        if (!isCurrent(run, context)) return;
        const answer = await deps.askPi(run.prKey, prompt, purpose);
        if (!isCurrent(run, context)) return;
        run.rawAnswer = answer;
        const provenance: AnalysisProvenance = { runId: run.id, version: ANALYSIS_VERSION, ...await deps.modelForRun(run.prKey, purpose) };
        if (!isCurrent(run, context)) return;
        const base = { prKey: run.prKey, headSha: run.headSha, answer, provenance };
        // Validate before saving; progress belongs to an artifact, never to a nearby old finding.
        const validated = resultFor(run.kind, { ...base, id: run.id, areaStates: {}, createdAt: run.startedAt, updatedAt: run.startedAt }, context);
        switch (validated.kind) {
          case "main-review":
            run.result = { ...validated, record: await deps.saveAiReview({ ...base, messages: [{ role: "pi", kind: "general-review", title: "General review", text: answer }] }) };
            break;
          case "focus-review":
            run.result = { ...validated, record: await deps.saveFocusScan({ ...base, areaStates: {} }) };
            break;
          case "guide-review":
            run.result = { ...validated, record: await deps.saveGuideReview(base) };
            break;
          case "code-walk":
            run.result = { ...validated, record: await deps.saveOverview(base) };
        }
      }
      if (isCurrent(run, context)) run.status = "complete";
    } catch (error) {
      if (run.status === "running") {
        run.status = error instanceof InvalidAnalysisError ? "invalid" : "failed";
        run.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (run.status === "running") {
        run.status = "cancelled";
        run.error = "The PR workspace changed while this analysis was running.";
      }
      run.finishedAt ??= new Date().toISOString();
      const key = JSON.stringify([run.prKey, run.headSha, run.kind]);
      if (active.get(key) === run) active.delete(key);
      deps.record?.("analysis:complete", { id: run.id, prKey: run.prKey, headSha: run.headSha, kind: run.kind, status: run.status, provenance: run.result?.record.provenance, startedAt: run.startedAt, finishedAt: run.finishedAt });
    }
  }

  async function start(payload: Record<string, unknown>): Promise<{ run: AnalysisRun }> {
    const { prKey, headSha, kind } = payload;
    if (typeof prKey !== "string" || typeof headSha !== "string" || !["main-review", "focus-review", "guide-review", "code-walk"].includes(String(kind))) throw new Error("Expected prKey, headSha, and analysis kind");
    const context = deps.contextForPr(prKey);
    if (context == null || context.headSha !== headSha) throw new Error("Open the current PR revision before starting analysis.");
    const key = JSON.stringify([prKey, headSha, kind]);
    const existing = active.get(key);
    if (existing != null) return { run: existing };
    // Finished artifacts are durable; only keep a bounded recent polling history in memory.
    for (const [id, run] of runs) {
      if (runs.size < 200) break;
      if (run.status !== "running") runs.delete(id);
    }
    const run: AnalysisRun = { id: randomUUID(), prKey, headSha, kind: kind as AnalysisKind, status: "running", startedAt: new Date().toISOString() };
    runs.set(run.id, run);
    active.set(key, run);
    void execute(run, context, payload.force === true);
    return { run };
  }

  async function status(payload: Record<string, unknown>): Promise<{ run: AnalysisRun }> {
    if (typeof payload.runId !== "string") throw new Error("Expected runId");
    const run = runs.get(payload.runId);
    if (run == null) throw new Error("Unknown analysis run; reopen the PR to load saved results.");
    if (run.status === "running" && deps.activity != null) {
      const activity = await deps.activity(run.prKey, run.kind === "code-walk" ? "flow-dag" : run.kind).catch(() => undefined);
      return { run: { ...run, activity } };
    }
    return { run };
  }

  return { start, status, invalidate };
}
