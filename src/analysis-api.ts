import { randomUUID } from "node:crypto";

import { ANALYSIS_VERSION, REVIEW_PAIR_VERSION, sameReviewPair, type AnalysisKind, type AnalysisProvenance, type AnalysisResult, type AnalysisRun } from "./analysis-types.js";
import { focusReviewIsInconclusive, parseFocusAreas, publishedFocusSection, splitFocusEvidence } from "./focus.js";
import { parseGuideChapters } from "./guide.js";
import type { ReviewDraftToolContext } from "./review-draft-tool.js";
import type { ReviewPromptApi } from "./review-prompt-api.js";
import type { StateStore } from "./state.js";
import type { SavedAnalysisApiDeps } from "./saved-analysis-api.js";
import type { AiReviewRecord, FocusScanRecord, GuideReviewRecord, StoredPullRequest } from "./types.js";

export type AnalysisApiDeps = Pick<SavedAnalysisApiDeps, "saveGuideReview" | "saveOverview"> & Pick<StateStore, "saveReviewPair"> & {
  contextForPr: (prKey: string) => ReviewDraftToolContext | null;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  listAiReviews: (prKey: string) => Promise<AiReviewRecord[]>;
  listFocusScans: (prKey: string) => Promise<FocusScanRecord[]>;
  listGuideReviews: (prKey: string) => Promise<GuideReviewRecord[]>;
  listOverviews: (prKey: string) => Promise<GuideReviewRecord[]>;
  buildPrompt: ReviewPromptApi["build"];
  askPi: (prKey: string, prompt: string, purpose: string, freshConversation?: boolean) => Promise<string>;
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

function checkedAnswer(text: string): string {
  const answer = text.trim();
  if (!answer || /^(?:Pi|AI review|Focus scan) completed without (?:assistant text|output)\.?$/i.test(answer)) throw new InvalidAnalysisError("Pi returned no final analysis.");
  return answer;
}

function currentArtifact<T extends { headSha: string; provenance?: AnalysisProvenance }>(record: T | undefined, headSha: string, version: number): record is T {
  return record?.headSha === headSha && record.provenance?.version === version;
}

function verifiedAreas(answer: string, context: ReviewDraftToolContext) {
  const areas = parseFocusAreas(checkedAnswer(answer), "verified");
  if (!areas.length && !focusReviewIsInconclusive(answer) && answer.trim() !== "No focus areas found.") throw new InvalidAnalysisError("Expected verified findings, a clean result or an explicit investigation limitation. See the raw response.");
  validateLocations(context, areas);
  if (areas.some(area => !area.title || area.title === "Focus area" || !splitFocusEvidence(area.body).explanation)) throw new InvalidAnalysisError("A verified finding needs an outcome title and a visible explanation below it.");
  return areas;
}

/** Validate HEAD-file navigation references, not publishable GitHub comment anchors. */
function validateLocations(context: ReviewDraftToolContext, areas: ReturnType<typeof parseFocusAreas>): void {
  for (const area of areas) {
    const file = context.files.find((candidate) => candidate.filename === area.path);
    if (file == null) throw new InvalidAnalysisError(`${area.path} is not a changed file in the current PR.`);
    if (file.status === "removed") throw new InvalidAnalysisError(`${area.path} has no HEAD file for analysis navigation.`);
    // Full-file navigation loads HEAD text on demand. A partial/missing patch cannot establish
    // EOF bounds, and surrounding code outside its hunks is a legitimate analysis destination.
    if (!Number.isSafeInteger(area.startLine) || !Number.isSafeInteger(area.endLine) || area.startLine < 1 || area.endLine < area.startLine) {
      throw new InvalidAnalysisError(`${area.path}: analysis lines must be positive safe integers in ascending order.`);
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
    const answer = checkedAnswer(record.answer);
    if (kind === "focus-review") {
      return { kind, record: record as FocusScanRecord, areas: verifiedAreas(answer, context) };
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

  function assertCurrent(run: AnalysisRun, context: ReviewDraftToolContext): void {
    if (!isCurrent(run, context)) throw new Error("The PR workspace changed during analysis.");
  }

  async function ask(run: AnalysisRun, context: ReviewDraftToolContext, mode: string, extra: Record<string, unknown>) {
    const { prompt, purpose } = await deps.buildPrompt({ ...extra, mode, prKey: run.prKey, files: context.files });
    assertCurrent(run, context);
    const answer = await deps.askPi(run.prKey, prompt, purpose, mode === "main-review" || mode === "focus-review");
    assertCurrent(run, context);
    return { answer: checkedAnswer(answer), purpose };
  }

  /** Only the reconciled verdict and surviving navigable evidence are durable. */
  async function reviewPair(main: AnalysisRun, focus: AnalysisRun, context: ReviewDraftToolContext, force: boolean) {
    const [review, scan, prs] = await Promise.all([previousRecord(main.kind, main.prKey, main.headSha), previousRecord(focus.kind, focus.prKey, focus.headSha), deps.listRecentPullRequests()]);
    assertCurrent(main, context);
    if (!force && currentArtifact(review, main.headSha, REVIEW_PAIR_VERSION) && currentArtifact(scan, main.headSha, REVIEW_PAIR_VERSION) && sameReviewPair(review, scan)) {
      main.result = resultFor(main.kind, review, context);
      focus.result = resultFor(focus.kind, scan, context);
    } else {
      const prTitle = prs.find(pr => pr.key === main.prKey)?.title ?? main.prKey;
      main.reviewStage = focus.reviewStage = "discovery";
      const [draft, independent] = await Promise.allSettled([
        ask(main, context, main.kind, { prTitle }),
        ask(focus, context, focus.kind, { prTitle }),
      ]);
      if (draft.status === "rejected") throw draft.reason;
      if (independent.status === "rejected") throw independent.reason;
      assertCurrent(main, context);
      const maintainerDraft = draft.value.answer;
      main.reviewStage = focus.reviewStage = "verification";
      const verified = await ask(focus, context, "review-verify", {
        maintainerDraft, investigation: independent.value.answer,
        previousAiReview: review?.answer, previousFocusAreas: scan?.answer,
      });
      const section = publishedFocusSection(verified.answer);
      const focusAnswer = section ?? verified.answer;
      let areas: ReturnType<typeof verifiedAreas>;
      try {
        if (section === undefined && !focusReviewIsInconclusive(verified.answer)) throw new InvalidAnalysisError("Verification did not separate its evidence from final focus areas.");
        areas = verifiedAreas(focusAnswer, context);
      } catch (error) {
        // Either view may be the only observer of this run; show diagnostics only on failure.
        main.rawAnswer = focus.rawAnswer = verified.answer;
        throw error;
      }
      main.reviewStage = focus.reviewStage = "synthesis";
      const final = await ask(main, context, "review-synthesis", { maintainerDraft, investigation: verified.answer });
      const [maintainer, investigator] = await Promise.all([deps.modelForRun(main.prKey, final.purpose), deps.modelForRun(focus.prKey, verified.purpose)]);
      assertCurrent(main, context);
      const provenance = { reviewPairId: main.id, version: REVIEW_PAIR_VERSION };
      const saved = await deps.saveReviewPair({
        review: { prKey: main.prKey, headSha: main.headSha, answer: final.answer, messages: [{ role: "pi", kind: "general-review", title: "General review", text: final.answer }], provenance: { ...provenance, ...maintainer, runId: main.id } },
        scan: { prKey: main.prKey, headSha: main.headSha, answer: focusAnswer, areaStates: {}, provenance: { ...provenance, ...investigator, runId: focus.id } },
      });
      assertCurrent(main, context);
      main.result = { kind: "main-review", record: saved.review };
      focus.result = { kind: "focus-review", areas, record: saved.scan };
    }
    main.companion = focus.result;
    focus.companion = main.result;
  }

  async function walkthrough(run: AnalysisRun, context: ReviewDraftToolContext, force: boolean) {
    const [previous, prs] = await Promise.all([previousRecord(run.kind, run.prKey, run.headSha), deps.listRecentPullRequests()]);
    assertCurrent(run, context);
    if (!force && currentArtifact(previous, run.headSha, ANALYSIS_VERSION)) {
      run.result = resultFor(run.kind, previous, context);
      return;
    }
    const { answer, purpose } = await ask(run, context, run.kind, { prTitle: prs.find(pr => pr.key === run.prKey)?.title ?? run.prKey });
    run.rawAnswer = answer;
    const provenance = { runId: run.id, version: ANALYSIS_VERSION, ...await deps.modelForRun(run.prKey, purpose) };
    assertCurrent(run, context);
    const base = { prKey: run.prKey, headSha: run.headSha, answer, provenance };
    const validated = resultFor(run.kind, { ...base, id: run.id, createdAt: run.startedAt, updatedAt: run.startedAt }, context);
    if (validated.kind === "guide-review") run.result = { ...validated, record: await deps.saveGuideReview(base) };
    else if (validated.kind === "code-walk") run.result = { ...validated, record: await deps.saveOverview(base) };
  }

  function newRun(prKey: string, headSha: string, kind: AnalysisKind): AnalysisRun {
    const run: AnalysisRun = { id: randomUUID(), prKey, headSha, kind, status: "running", startedAt: new Date().toISOString() };
    runs.set(run.id, run);
    active.set(JSON.stringify([prKey, headSha, kind]), run);
    return run;
  }

  async function execute(run: AnalysisRun, companion: AnalysisRun | undefined, context: ReviewDraftToolContext, force: boolean) {
    const participants = companion ? [run, companion] : [run];
    try {
      if (companion) await reviewPair(run.kind === "main-review" ? run : companion, run.kind === "focus-review" ? run : companion, context, force);
      else await walkthrough(run, context, force);
      for (const item of participants) if (isCurrent(item, context)) item.status = "complete";
    } catch (error) {
      for (const item of participants) if (isCurrent(item, context)) {
        item.status = error instanceof InvalidAnalysisError ? "invalid" : "failed";
        item.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      for (const item of participants) {
        if (item.status === "running") {
          item.status = "cancelled";
          item.error = "The PR workspace changed while this analysis was running.";
        }
        item.finishedAt ??= new Date().toISOString();
        const key = JSON.stringify([item.prKey, item.headSha, item.kind]);
        if (active.get(key) === item) active.delete(key);
        deps.record?.("analysis:complete", { id: item.id, prKey: item.prKey, headSha: item.headSha, kind: item.kind, status: item.status, provenance: item.result?.record.provenance, startedAt: item.startedAt, finishedAt: item.finishedAt });
      }
    }
  }

  async function start(payload: Record<string, unknown>): Promise<{ run: AnalysisRun }> {
    const { prKey, headSha, kind } = payload;
    if (typeof prKey !== "string" || typeof headSha !== "string" || (kind !== "main-review" && kind !== "focus-review" && kind !== "guide-review" && kind !== "code-walk")) throw new Error("Expected prKey, headSha, and analysis kind");
    const context = deps.contextForPr(prKey);
    if (context == null || context.headSha !== headSha) throw new Error("Open the current PR revision before starting analysis.");
    const existing = active.get(JSON.stringify([prKey, headSha, kind]));
    if (existing) return { run: existing };
    for (const [id, run] of runs) {
      if (runs.size < 199) break;
      if (run.status !== "running") runs.delete(id);
    }
    const run = newRun(prKey, headSha, kind);
    const companion = kind === "main-review" || kind === "focus-review" ? newRun(prKey, headSha, kind === "main-review" ? "focus-review" : "main-review") : undefined;
    void execute(run, companion, context, payload.force === true);
    return { run };
  }

  async function status(payload: Record<string, unknown>): Promise<{ run: AnalysisRun }> {
    if (typeof payload.runId !== "string") throw new Error("Expected runId");
    const run = runs.get(payload.runId);
    if (run == null) throw new Error("Unknown analysis run; reopen the PR to load saved results.");
    if (run.status === "running" && deps.activity != null) {
      const purpose = run.reviewStage === "verification" ? "focus-review" : run.reviewStage === "synthesis" ? "main-review" : run.kind === "code-walk" ? "flow-dag" : run.kind;
      const activity = await deps.activity(run.prKey, purpose).catch(() => undefined);
      return { run: { ...run, activity: activity && run.reviewStage ? { ...activity, label: `${run.reviewStage} · ${activity.label}` } : activity } };
    }
    return { run };
  }

  return { start, status, invalidate };
}
