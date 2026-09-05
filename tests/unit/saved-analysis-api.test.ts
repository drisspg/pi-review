import assert from "node:assert/strict";
import test from "node:test";

import { createSavedAnalysisApi } from "../../src/saved-analysis-api.js";
import type { AiReviewRecord, FocusAreaReviewState, FocusScanRecord, GuideReviewRecord } from "../../src/types.js";

const areaStates: Record<string, FocusAreaReviewState> = {
  "src/a.ts": { viewed: true, collapsed: false, updatedAt: "2026-06-04T00:00:00.000Z" },
};

function fakeDeps() {
  const focusInputs: Array<Parameters<ReturnType<typeof createSavedAnalysisApi>["saveFocusScan"]>[0]> = [];
  const aiInputs: Array<Parameters<ReturnType<typeof createSavedAnalysisApi>["saveAiReview"]>[0]> = [];
  const guideInputs: Array<Parameters<ReturnType<typeof createSavedAnalysisApi>["saveGuideReview"]>[0]> = [];
  const progressInputs: Array<Record<string, unknown>> = [];
  const overviewInputs: Array<Record<string, unknown>> = [];
  return {
    progressInputs,
    focusInputs,
    aiInputs,
    guideInputs,
    overviewInputs,
    deps: {
      async updateFocusScanProgress(input: Pick<FocusScanRecord, "prKey" | "id" | "areaStates">) {
        progressInputs.push(input);
        return { ...input, headSha: "old", answer: "saved", createdAt: "then", updatedAt: "now" };
      },
      async updateGuideReviewProgress(input: Pick<GuideReviewRecord, "prKey" | "id"> & { stepStates: NonNullable<GuideReviewRecord["stepStates"]> }) {
        progressInputs.push(input);
        return { ...input, headSha: "old", answer: "saved", createdAt: "then", updatedAt: "now" };
      },
      async saveFocusScan(scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>) {
        focusInputs.push(scan as Record<string, unknown>);
        return { ...scan, id: scan.id ?? "focus-id", createdAt: scan.createdAt ?? "then", updatedAt: "now" } as FocusScanRecord;
      },
      async saveAiReview(review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>) {
        aiInputs.push(review as Record<string, unknown>);
        return { ...review, id: review.id ?? "ai-id", createdAt: review.createdAt ?? "then", updatedAt: "now" } as AiReviewRecord;
      },
      async saveGuideReview(review: Omit<GuideReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<GuideReviewRecord, "id" | "createdAt">>) {
        guideInputs.push(review as Record<string, unknown>);
        return { ...review, id: review.id ?? "guide-id", createdAt: review.createdAt ?? "then", updatedAt: "now" } as GuideReviewRecord;
      },
      async saveOverview(record: Omit<GuideReviewRecord, "id" | "createdAt" | "updatedAt" | "stepStates">) {
        overviewInputs.push(record as Record<string, unknown>);
        return { ...record, id: "overview-id", createdAt: "then", updatedAt: "now" } as GuideReviewRecord;
      },
    },
  };
}

test("saved analysis API saves focus scans with optional id", async () => {
  const { deps, focusInputs } = fakeDeps();

  const response = await createSavedAnalysisApi(deps).saveFocusScan({ id: "existing", prKey: "pr", headSha: "head", answer: "answer", areaStates });

  assert.equal(response.scan.id, "existing");
  assert.deepEqual(focusInputs, [{ id: "existing", prKey: "pr", headSha: "head", answer: "answer", areaStates }]);
});

test("saved analysis API saves AI reviews with optional messages", async () => {
  const { deps, aiInputs } = fakeDeps();
  const messages = [{ role: "user", text: "prompt" }, { role: "pi", text: "answer", title: "Review", kind: "general-review" }];

  const response = await createSavedAnalysisApi(deps).saveAiReview({ prKey: "pr", headSha: "head", answer: "answer", messages });

  assert.equal(response.review.id, "ai-id");
  assert.deepEqual(aiInputs, [{ id: undefined, prKey: "pr", headSha: "head", answer: "answer", messages }]);
});

test("saved analysis API saves head-scoped guide reviews", async () => {
  const { deps, guideInputs } = fakeDeps();

  const response = await createSavedAnalysisApi(deps).saveGuideReview({ prKey: "pr", headSha: "head", answer: "guide" });

  assert.equal(response.guide.id, "guide-id");
  assert.deepEqual(guideInputs, [{ prKey: "pr", headSha: "head", answer: "guide" }]);
});

test("saved analysis API saves head-scoped overviews", async () => {
  const { deps, overviewInputs } = fakeDeps();

  const response = await createSavedAnalysisApi(deps).saveOverview({ prKey: "pr", headSha: "head", answer: "overview" });

  assert.equal(response.overview.id, "overview-id");
  assert.deepEqual(overviewInputs, [{ prKey: "pr", headSha: "head", answer: "overview" }]);
});

test("saved analysis API forwards guide step states when provided", async () => {
  const { deps, guideInputs } = fakeDeps();
  const stepStates = { "src/a.ts:1-2:0": { reviewed: true, updatedAt: "now" } };

  await createSavedAnalysisApi(deps).saveGuideReview({ prKey: "pr", headSha: "head", answer: "guide", stepStates });

  assert.deepEqual(guideInputs, [{ prKey: "pr", headSha: "head", answer: "guide", stepStates }]);
});

test("saved analysis API validates focus scan payload shape", async () => {
  const api = createSavedAnalysisApi(fakeDeps().deps);

  await assert.rejects(api.saveFocusScan({ prKey: "pr", headSha: "head", answer: "answer", areaStates: [] }), /Expected focus scan payload/);
  await assert.rejects(api.saveFocusScan({ prKey: "pr", headSha: "head", areaStates }), /Expected focus scan payload/);
});

test("saved analysis API validates AI and guide review payloads", async () => {
  const api = createSavedAnalysisApi(fakeDeps().deps);

  await assert.rejects(api.saveAiReview({ prKey: "pr", headSha: "head" }), /Expected AI review payload/);
  await assert.rejects(api.saveGuideReview({ prKey: "pr", headSha: "head" }), /Expected guide review payload/);
});


test("progress API forwards identity and progress without caller artifact content", async () => {
  const { deps, progressInputs } = fakeDeps();
  const api = createSavedAnalysisApi(deps);
  const stepStates = { stop: { reviewed: true, updatedAt: "now" } };
  const scan = await api.updateFocusScanProgress({ prKey: "pr", id: "old-focus", areaStates, headSha: "new", answer: "overwrite" });
  const guide = await api.updateGuideReviewProgress({ prKey: "pr", id: "old-guide", stepStates, headSha: "new", answer: "overwrite" });
  assert.deepEqual(progressInputs, [{ prKey: "pr", id: "old-focus", areaStates }, { prKey: "pr", id: "old-guide", stepStates }]);
  assert.equal(scan.scan.headSha, "old");
  assert.equal(guide.guide.answer, "saved");
});

test("progress API requires an artifact id and progress object", async () => {
  const { deps, progressInputs } = fakeDeps();
  const api = createSavedAnalysisApi(deps);
  await assert.rejects(api.updateFocusScanProgress({ prKey: "pr", areaStates }), /Expected/);
  await assert.rejects(api.updateFocusScanProgress({ prKey: "pr", id: "id", areaStates: [] }), /Expected/);
  await assert.rejects(api.updateGuideReviewProgress({ prKey: "pr", stepStates: {} }), /Expected/);
  await assert.rejects(api.updateGuideReviewProgress({ prKey: "pr", id: "id", stepStates: null }), /Expected/);
  assert.deepEqual(progressInputs, []);
});

test("legacy guide saves forward explicit identity for immutable validation", async () => {
  const { deps, guideInputs } = fakeDeps();
  await createSavedAnalysisApi(deps).saveGuideReview({ prKey: "pr", id: "old", headSha: "head", answer: "guide" });
  assert.equal(guideInputs[0].id, "old");
});
