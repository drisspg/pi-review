import assert from "node:assert/strict";
import test from "node:test";

import { createAnalysisApi, type AnalysisApiDeps } from "../../src/analysis-api.js";
import { ANALYSIS_VERSION, type AnalysisRun } from "../../src/analysis-types.js";
import type { ReviewDraftToolContext } from "../../src/review-draft-tool.js";

const context: ReviewDraftToolContext = { headSha: "head", files: [{ filename: "Makefile", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@ -1 +1,3 @@\n target:\n+\techo build\n+\techo done" }] };

function fixture(answer = "No focus areas found.") {
  let current: ReviewDraftToolContext | null = context;
  const saved: Record<string, unknown>[] = [];
  const prompts: Record<string, unknown>[] = [];
  const deps: AnalysisApiDeps = {
    contextForPr: () => current,
    listRecentPullRequests: async () => [],
    listAiReviews: async () => [], listFocusScans: async () => [], listGuideReviews: async () => [], listOverviews: async () => [],
    buildPrompt: async (payload) => { prompts.push(payload); return { prompt: "server-built prompt", purpose: String(payload.mode) }; },
    askPi: async () => answer,
    modelForRun: async () => ({ model: "openai-codex/gpt-6-astra", thinkingLevel: "medium" }),
    saveAiReview: async (record) => { saved.push(record); return { ...record, id: "review", createdAt: "now", updatedAt: "now" }; },
    saveFocusScan: async (record) => { saved.push(record); return { ...record, id: "scan", createdAt: "now", updatedAt: "now" }; },
    saveGuideReview: async (record) => { saved.push(record); return { ...record, id: "guide", createdAt: "now", updatedAt: "now" }; },
    saveOverview: async (record) => { saved.push(record); return { ...record, id: "overview", createdAt: "now", updatedAt: "now" }; },
  };
  return { deps, saved, prompts, setContext: (next: ReviewDraftToolContext | null) => { current = next; } };
}

/** Wait for deterministic fake work without coupling tests to polling intervals. */
async function settled(run: AnalysisRun): Promise<AnalysisRun> {
  for (let i = 0; i < 100 && run.status === "running"; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(run.status, "running");
  return run;
}

test("analysis persists without a browser and ignores client-supplied prompts/files", async () => {
  const f = fixture();
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review", prompt: "untrusted", files: [] });
  await settled(run);
  assert.equal(run.status, "complete");
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.prompts[0].files, context.files);
  assert.equal(run.result?.record.provenance?.version, ANALYSIS_VERSION);
  assert.equal(run.result?.record.headSha, "head");
  assert.deepEqual((await api.status({ runId: run.id })).run, run);
});

test("simultaneous requests join one run, including forced refreshes", async () => {
  const f = fixture();
  let finish!: (answer: string) => void;
  f.deps.askPi = () => new Promise((resolve) => { finish = resolve; });
  const api = createAnalysisApi(f.deps);
  const [a, b] = await Promise.all([api.start({ prKey: "pr", headSha: "head", kind: "focus-review" }), api.start({ prKey: "pr", headSha: "head", kind: "focus-review", force: true })]);
  assert.equal(a.run.id, b.run.id);
  await new Promise((resolve) => setImmediate(resolve));
  finish("No focus areas found.");
  await settled(a.run);
  assert.equal(f.saved.length, 1);
});

test("invalid output and invalid anchors never persist or count as clean", async () => {
  for (const answer of ["I could not complete this scan.", "Pi completed without assistant text.", "- other.ts:2 — Bug", "- Makefile:99 — Bug"]) {
    const f = fixture(answer);
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
    await settled(run);
    assert.equal(run.status, "invalid", answer);
    assert.equal(run.rawAnswer, answer);
    assert.equal(f.saved.length, 0);
  }
});

test("extensionless file findings are validated and returned as typed areas", async () => {
  const f = fixture("- Makefile:2-3 — Build failure\nThe target exits early.");
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "complete");
  assert.equal(run.result?.kind, "focus-review");
  if (run.result?.kind === "focus-review") assert.equal(run.result.areas[0].path, "Makefile");
});

test("refresh invalidates old work before it can save", async () => {
  const f = fixture();
  let finish!: (answer: string) => void;
  f.deps.askPi = () => new Promise((resolve) => { finish = resolve; });
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await new Promise((resolve) => setImmediate(resolve));
  api.invalidate("pr");
  f.setContext({ ...context, headSha: "new" });
  finish("No focus areas found.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.status, "cancelled");
  assert.equal(f.saved.length, 0);
  await assert.rejects(api.start({ prKey: "pr", headSha: "head", kind: "focus-review" }), /current PR revision/);
});

test("same-HEAD metadata refreshes do not cancel an active analysis", async () => {
  const f = fixture();
  let finish!: (answer: string) => void;
  f.deps.askPi = () => new Promise((resolve) => { finish = resolve; });
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await new Promise((resolve) => setImmediate(resolve));
  f.setContext({ ...context, files: [...context.files] });
  finish("No focus areas found.");
  await settled(run);
  assert.equal(run.status, "complete");
  assert.equal(f.saved.length, 1);
  await assert.rejects(api.status({ runId: "unknown" }), /Unknown analysis run/);
});

test("failures can be retried and do not poison deduplication", async () => {
  const f = fixture();
  f.deps.askPi = async () => { throw new Error("model unavailable"); };
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "failed");
  f.deps.askPi = async () => "No focus areas found.";
  const retry = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(retry.run);
  assert.equal(retry.run.status, "complete");
  assert.notEqual(run.id, retry.run.id);
});

test("guide and overview contracts reject incomplete artifacts", async () => {
  for (const kind of ["guide-review", "code-walk"] as const) {
    const f = fixture("Partial response");
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind });
    await settled(run);
    assert.equal(run.status, "invalid");
    assert.equal(f.saved.length, 0);
  }
});

test("current version artifacts are reused; old prompt versions regenerate", async () => {
  const f = fixture();
  f.deps.listFocusScans = async () => [{ id: "cached", prKey: "pr", headSha: "head", answer: "No focus areas found.", areaStates: {}, createdAt: "now", updatedAt: "now", provenance: { runId: "old", version: ANALYSIS_VERSION, model: "astra", thinkingLevel: "medium" } }];
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.result?.record.id, "cached");
  assert.equal(f.prompts.length, 0);
  const refreshed = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review", force: true });
  await settled(refreshed.run);
  assert.equal(f.prompts.length, 1);
});
