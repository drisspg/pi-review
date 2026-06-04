import assert from "node:assert/strict";
import test from "node:test";

import { createSavedAnalysisApi } from "../../src/saved-analysis-api.js";
import type { AiReviewRecord, FocusAreaReviewState, FocusScanRecord } from "../../src/types.js";

const areaStates: Record<string, FocusAreaReviewState> = {
  "src/a.ts": { viewed: true, collapsed: false, updatedAt: "2026-06-04T00:00:00.000Z" },
};

function fakeDeps() {
  const focusInputs: Array<Parameters<ReturnType<typeof createSavedAnalysisApi>["saveFocusScan"]>[0]> = [];
  const aiInputs: Array<Parameters<ReturnType<typeof createSavedAnalysisApi>["saveAiReview"]>[0]> = [];
  return {
    focusInputs,
    aiInputs,
    deps: {
      async saveFocusScan(scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>) {
        focusInputs.push(scan as Record<string, unknown>);
        return { ...scan, id: scan.id ?? "focus-id", createdAt: scan.createdAt ?? "then", updatedAt: "now" } as FocusScanRecord;
      },
      async saveAiReview(review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>) {
        aiInputs.push(review as Record<string, unknown>);
        return { ...review, id: review.id ?? "ai-id", createdAt: review.createdAt ?? "then", updatedAt: "now" } as AiReviewRecord;
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

test("saved analysis API validates focus scan payload shape", async () => {
  const api = createSavedAnalysisApi(fakeDeps().deps);

  await assert.rejects(api.saveFocusScan({ prKey: "pr", headSha: "head", answer: "answer", areaStates: [] }), /Expected focus scan payload/);
  await assert.rejects(api.saveFocusScan({ prKey: "pr", headSha: "head", areaStates }), /Expected focus scan payload/);
});

test("saved analysis API validates AI review payload shape", async () => {
  const api = createSavedAnalysisApi(fakeDeps().deps);

  await assert.rejects(api.saveAiReview({ prKey: "pr", headSha: "head" }), /Expected AI review payload/);
});
