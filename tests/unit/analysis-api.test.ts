import assert from "node:assert/strict";
import test from "node:test";

import { createAnalysisApi, type AnalysisApiDeps } from "../../src/analysis-api.js";
import { REVIEW_PAIR_VERSION, type AnalysisRun } from "../../src/analysis-types.js";
import { validateReviewDraftTarget, type ReviewDraftToolContext } from "../../src/review-draft-tool.js";

const context: ReviewDraftToolContext = { headSha: "head", files: [{ filename: "Makefile", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "@@ -1 +1,3 @@\n target:\n+\techo build\n+\techo done" }] };

const visual = ["```review-visual", "Base: source → old result", "HEAD: source → new result", "```"].join("\n");
const graph = (edges: Array<{ from: string; to: string }>) => "```schematic\n" + JSON.stringify({
  nodes: [{ id: "worker", label: "Worker 0" }, { id: "rows", label: "Rows [0, n)" }], edges,
}, null, 2) + "\n```";
const assignment = graph([{ from: "worker", to: "rows" }]);
const verdict = `Verified verdict.\n\n${visual}`;

function fixture(answer = "No focus areas found.") {
  let current: ReviewDraftToolContext | null = context;
  const saved: unknown[] = [];
  const prompts: Record<string, unknown>[] = [];
  const deps: AnalysisApiDeps = {
    contextForPr: () => current,
    listRecentPullRequests: async () => [],
    listAiReviews: async () => [], listFocusScans: async () => [], listGuideReviews: async () => [], listOverviews: async () => [],
    buildPrompt: async (payload) => { prompts.push(payload); return { prompt: String(payload.mode), purpose: String(payload.mode) }; },
    askPi: async (_pr, _prompt, mode) => mode === "review-verify" ? `Verification evidence\n## Focus areas\n${answer.replace(/^## Focus areas\s*\n/, "")}` : ["guide-review", "code-walk"].includes(mode) ? answer : mode === "review-synthesis" ? verdict : `${mode} result`,
    modelForRun: async () => ({ model: "openai-codex/gpt-6-astra", thinkingLevel: "medium" }),
    saveReviewPair: async pair => {
      saved.push(pair);
      const timestamps = { createdAt: "now", updatedAt: "now" };
      return { review: { ...pair.review, ...timestamps, id: "review" }, scan: { ...pair.scan, ...timestamps, id: "scan" } };
    },
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
  assert.equal(run.result?.record.provenance?.version, REVIEW_PAIR_VERSION);
  assert.equal(run.result?.record.headSha, "head");
  assert.deepEqual((await api.status({ runId: run.id })).run, run);
});

test("simultaneous requests join one run, including forced refreshes", async () => {
  const f = fixture();
  let finish!: (answer: string) => void;
  const ask = f.deps.askPi;
  f.deps.askPi = (pr, mode, purpose) => mode === "focus-review" ? new Promise((resolve) => { finish = resolve; }) : ask(pr, mode, purpose);
  const api = createAnalysisApi(f.deps);
  const [a, b] = await Promise.all([api.start({ prKey: "pr", headSha: "head", kind: "focus-review" }), api.start({ prKey: "pr", headSha: "head", kind: "focus-review", force: true })]);
  assert.equal(a.run.id, b.run.id);
  await new Promise((resolve) => setImmediate(resolve));
  finish("No focus areas found.");
  await settled(a.run);
  assert.equal(f.saved.length, 1);
});

test("invalid output and invalid anchors never persist or count as clean", async () => {
  for (const answer of ["I could not complete this scan.", "Pi completed without assistant text.", "### other.ts:2 — Bug\nWrong file.", "### Makefile:0 — Bug\nInvalid line.", "### Makefile:9007199254740992 — Bug\nUnsafe line number.", "### Makefile:2", "### Makefile:2 — Headline only", "### Makefile:2 — Trace only\n### Evidence\nstack frame", "- Makefile:2 — Untitled section\nAn explanation.\n### Evidence\n- Makefile:3 — Citation\nA trace, not another finding."]) {
    const f = fixture(answer);
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
    await settled(run);
    assert.equal(run.status, "invalid", answer);
    assert.ok(run.rawAnswer?.endsWith(answer));
    assert.equal(f.saved.length, 0);
  }
});

test("extensionless file findings are validated and returned as typed areas", async () => {
  const f = fixture(`### Makefile:2-3 — Build failure\nThe target exits early.\n\n${visual}`);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "complete");
  assert.equal(run.result?.kind, "focus-review");
  if (run.result?.kind === "focus-review") assert.equal(run.result.areas[0].path, "Makefile");
});

test("mixed prose and a clean marker below the publication boundary do not count as clean", async () => {
  const answer = "Checked the routing algebra, staged backward contracts, nightly collective autograd support, and nearby tests. The PR reports 14 passing two-GPU tests plus GB200 graph validation; I couldn’t independently rerun CUDA/NCCL tests on this macOS host. No high-signal concern survived the read-only investigation.No focus areas found.";
  const f = fixture(answer);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "invalid");
  assert.equal(f.saved.length, 0);
});

for (const kind of ["guide-review", "focus-review"] as const) {
  test(`${kind} navigates surrounding HEAD code without requiring a reviewable patch`, async () => {
    for (const patch of [context.files[0].patch, undefined]) {
      const location = `${kind === "guide-review" ? "-" : "###"} model.py:542-550 — Follow the caller\nInspect surrounding implementation.`;
      const f = fixture(kind === "guide-review" ? `## Review guide\n### 1. Call path\n${location}` : `## Focus areas\n${location}\n\n${visual}`);
      const navigationContext = { ...context, files: [{ ...context.files[0], filename: "model.py", patch }] };
      f.setContext(navigationContext);
      const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind });
      await settled(run);
      assert.equal(run.status, "complete", run.error);
      assert.equal(f.saved.length, 1);
      const areas = run.result?.kind === "guide-review" ? run.result.chapters[0].steps : run.result?.kind === "focus-review" ? run.result.areas : [];
      assert.deepEqual(areas.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })), [{ path: "model.py", startLine: 542, endLine: 550 }]);
      assert.throws(() => validateReviewDraftTarget(navigationContext, { path: "model.py", line: 542, body: "Actual inline comment" }), /not reviewable|patch.*unavailable/);
    }
  });

  test(`${kind} rejects deleted-file navigation targets`, async () => {
    const location = `${kind === "guide-review" ? "-" : "###"} Makefile:2 — Removed code\nThis location is gone from HEAD.`;
    const f = fixture(kind === "guide-review" ? `## Review guide\n### 1. Removal\n${location}` : location);
    f.setContext({ ...context, files: [{ ...context.files[0], status: "removed" }] });
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind });
    await settled(run);
    assert.equal(run.status, "invalid");
    assert.equal(f.saved.length, 0);
  });

  test(`${kind} ranges may connect two reviewable diff hunks`, async () => {
    const location = `${kind === "guide-review" ? "-" : "###"} Makefile:2-21 — Follow the build path\nCheck how setup connects to the later target.`;
    const f = fixture(kind === "guide-review" ? `## Review guide\n### 1. Build lifecycle\n${location}` : `## Focus areas\n${location}\n\n${visual}`);
    const twoHunks = { ...context, files: [{ ...context.files[0], patch: "@@ -1,3 +1,3 @@\n target:\n-\techo old\n+\techo new\n context\n@@ -20,3 +20,3 @@\n later:\n-\techo before\n+\techo after\n end" }] };
    f.setContext(twoHunks);
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind });
    await settled(run);
    assert.equal(run.status, "complete", run.error);
    assert.equal(f.saved.length, 1);
    assert.throws(() => validateReviewDraftTarget(twoHunks, { path: "Makefile", startLine: 2, line: 21, body: "Actual inline comment" }), /same diff hunk/);
  });
}

test("refresh invalidates old work before it can save", async () => {
  const f = fixture();
  let finish!: (answer: string) => void;
  const ask = f.deps.askPi;
  f.deps.askPi = (pr, mode, purpose) => mode === "focus-review" ? new Promise((resolve) => { finish = resolve; }) : ask(pr, mode, purpose);
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
  const ask = f.deps.askPi;
  f.deps.askPi = (pr, mode, purpose) => mode === "focus-review" ? new Promise((resolve) => { finish = resolve; }) : ask(pr, mode, purpose);
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
  const ask = f.deps.askPi;
  f.deps.askPi = async () => { throw new Error("model unavailable"); };
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "failed");
  f.deps.askPi = ask;
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

test("reuse a current pair, but regenerate on force or a missing companion", async () => {
  const f = fixture();
  f.deps.listAiReviews = async () => [{ id: "review", prKey: "pr", headSha: "head", answer: verdict, createdAt: "now", updatedAt: "now", provenance: { runId: "main", reviewPairId: "pair", version: REVIEW_PAIR_VERSION, model: "astra", thinkingLevel: "medium" } }];
  f.deps.listFocusScans = async () => [{ id: "cached", prKey: "pr", headSha: "head", answer: "No focus areas found.", areaStates: {}, createdAt: "now", updatedAt: "now", provenance: { runId: "old", reviewPairId: "pair", version: REVIEW_PAIR_VERSION, model: "astra", thinkingLevel: "medium" } }];
  const api = createAnalysisApi(f.deps);
  const { run } = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.result?.record.id, "cached");
  assert.equal(f.prompts.length, 0);
  const refreshed = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review", force: true });
  await settled(refreshed.run);
  assert.equal(f.prompts.length, 4);
  // A same-HEAD legacy/imported half is not evidence for this verdict.
  f.deps.listAiReviews = async () => [];
  const orphan = await api.start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(orphan.run);
  assert.notEqual(orphan.run.result?.record.id, "cached");
  assert.equal(f.prompts.length, 8);
});

test("both views join one investigation; only verified evidence and the reconciled verdict survive", async () => {
  const f = fixture();
  const answers: Record<string, string> = {
    "main-review": "Possible blocker: unsupported flag",
    "focus-review": "Investigate cache lifetime",
    "review-verify": `Makefile:1 — flag claim refuted; no supported caller.\n## Focus areas\n### Makefile:2 — retired build retained\nObserved after clear and relaunch.\n\n${visual}`,
    "review-synthesis": `Address the verified cache regression before landing.\n\n${visual}`,
  };
  const freshTurns: string[] = [];
  f.deps.askPi = async (_, mode, _purpose, freshConversation) => {
    if (freshConversation) freshTurns.push(mode);
    return answers[mode];
  };
  const api = createAnalysisApi(f.deps);
  const start = (kind: string) => api.start({ prKey: "pr", headSha: "head", kind });
  const [{run: main}, {run: focus}] = await Promise.all([start("main-review"), start("focus-review")]);
  await settled(main);
  assert.equal(focus.status, "complete");
  assert.equal(main.result?.record.answer, answers["review-synthesis"]);
  assert.deepEqual(main.companion, focus.result);
  assert.deepEqual(focus.companion, main.result);
  assert.equal(main.result?.record.provenance?.reviewPairId, focus.result?.record.provenance?.reviewPairId);
  assert.equal(focus.result?.kind, "focus-review");
  if (focus.result?.kind === "focus-review") assert.deepEqual(focus.result.areas.map(a => a.title), ["retired build retained"]);
  assert.ok(!JSON.stringify(f.saved).includes("flag"));
  assert.deepEqual(f.prompts.map(p => p.mode), ["main-review", "focus-review", "review-verify", "review-synthesis"]);
  assert.deepEqual(freshTurns.sort(), ["focus-review", "main-review"]);
  assert.equal(f.prompts[2].maintainerDraft, answers["main-review"]);
  assert.equal(f.prompts[2].investigation, answers["focus-review"]);
  assert.equal(f.prompts[3].investigation, answers["review-verify"]);
});

test("an unavailable decisive check persists as inconclusive, not clean or a defect", async () => {
  const answer = "Investigation inconclusive: no device to test accumulation order.";
  const f = fixture(answer);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
  await settled(run);
  assert.equal(run.status, "complete");
  assert.equal(run.companion?.record.answer, answer);
});

test("a main-review request exposes malformed verifier diagnostics without publishing findings", async () => {
  for (const malformed of ["Makefile:1 — private hypothesis", "## Focus areas\n## Focus areas\nNo focus areas found."]) {
    const f = fixture();
    const ask = f.deps.askPi;
    f.deps.askPi = async (...args) => args[1] === "review-verify" ? malformed : ask(...args);
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
    await settled(run);
    assert.equal(run.status, "invalid");
    assert.equal(run.rawAnswer, malformed);
    assert.equal(f.saved.length, 0);
  }
});

test("a failed synthesis cannot publish a new focus artifact by itself", async () => {
  const f = fixture();
  const ask = f.deps.askPi;
  f.deps.askPi = async (...args) => {
    if (args[1] === "review-synthesis") throw new Error("model unavailable");
    return ask(...args);
  };
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "failed");
  assert.equal(f.saved.length, 0);
});

test("a verified finding needs a visible visual of its own, not a diagram hidden in Evidence or in another finding", async () => {
  const f = fixture(`### Makefile:2 — Build stops\nThe command fails.\n\n${visual}\n### Makefile:3 — Output is missing\nThe missing output breaks the caller.\n### Evidence\n${visual}`);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "invalid");
  assert.match(run.error!, /visual/i);
  assert.equal(f.saved.length, 0);
});

test("a repaired focus visual reaches synthesis and the saved finding without changing Evidence", async () => {
  const head = "## Focus areas\n### Makefile:2 — Build stops\nThe build exits early.";
  const evidence = "\n\n### Evidence\nCompared both revisions.";
  const corrected = head + "\n\n" + visual + evidence;
  const f = fixture();
  const ask = f.deps.askPi;
  f.deps.askPi = (...args) => args[2] === "review-verify"
    ? Promise.resolve(args[1] === "review-verify" ? head + evidence : visual) : ask(...args);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "complete");
  assert.ok(run.result?.record.answer.endsWith(visual + evidence));
  assert.equal(f.prompts.at(-1)?.investigation, corrected);
});

test("the diagram-only retry replaces a multiline schematic without rewriting either finding or its evidence", async () => {
  const prefix = "## Focus areas\n### Makefile:2 — Missing rows\nA worker exits early.  \n\n```diff excerpt\n- old bound\n+ new bound\n```\n\n";
  const suffix = `\n\nCheck the last assigned row.\n\n### Evidence\nOriginal trace.\n### Makefile:3 — Missing output\nSecond finding.\n\n${assignment}`;
  const invalid = graph([{ from: "worker", to: "rows" }, { from: "worker", to: "missing" }]);
  const f = fixture();
  const ask = f.deps.askPi;
  f.deps.askPi = (...args) => args[2] === "review-verify"
    ? Promise.resolve(args[1] === "review-verify" ? prefix + invalid + suffix : assignment) : ask(...args);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "complete", run.error);
  assert.equal(f.prompts.at(-1)?.investigation, prefix + assignment + suffix);
  assert.equal(run.result?.record.answer, (prefix + assignment + suffix).slice("## Focus areas\n".length));
});

test("a row sketch can explain the finding in place, before the discriminating check", async () => {
  const sketch = ["```text", "rows      0 … 63 | 64 … 71", "output    [valid]| [guard]", "unexpected write   ^^^^^^^", "```"].join("\n");
  const body = `There is no row left to write.\n\n${sketch}\n\nCheck that the guard stays unchanged.`;
  const f = fixture(`### Makefile:2 — Empty work writes into the guard\n${body}`);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "complete", run.error);
  assert.equal(run.result?.record.answer.includes(body), true);
});

test("a general verdict needs exactly one figure with real relationships", async () => {
  for (const figure of [assignment, assignment + "\n\n" + visual, graph([]), graph([{ from: "worker", to: "missing" }]), assignment.slice(0, -3)]) {
    const f = fixture();
    const ask = f.deps.askPi;
    const answer = "The worker owns the tile.\n\n" + figure;
    f.deps.askPi = (...args) => args[2] === "review-synthesis" ? Promise.resolve(answer) : ask(...args);
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
    await settled(run);
    if (figure === assignment) assert.equal(run.result?.record.answer, answer);
    else {
      assert.equal(run.status, "invalid");
      assert.equal(run.rawAnswer, answer.trim());
      assert.equal(f.saved.length, 0);
    }
  }
});

test("repair only a malformed verdict visual in the existing maintainer session", async () => {
  const f = fixture();
  const ask = f.deps.askPi;
  let attempts = 0;
  f.deps.askPi = async (...args) => {
    if (args[2] !== "review-synthesis") return ask(...args);
    attempts++;
    if (attempts === 1) return "Verified verdict.\n\n```review-visual\nOnly one lane\n```";
    assert.ok(!args[3], "a formatting correction must not reset the conversation");
    return visual;
  };
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
  await settled(run);
  assert.equal(attempts, 2);
  assert.equal(run.result?.record.answer, verdict);
  assert.equal(f.prompts.length, 4, "discovery and verification aren't rerun");
});

for (const suffix of ["", "\n    ```"]) test(`a repair cannot replace evidence swallowed by ${suffix ? "an indented closer" : "an unterminated fence"}`, async () => {
  const original = "## Focus areas\n### Makefile:2 — Build stops\nThe target fails.\n\n```review-visual\n### Evidence\nOriginal trace" + suffix;
  const f = fixture();
  const ask = f.deps.askPi;
  f.deps.askPi = (...args) => args[2] === "review-verify" ? Promise.resolve(args[1] === "review-verify" ? original : visual) : ask(...args);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "focus-review" });
  await settled(run);
  assert.equal(run.status, "invalid");
  assert.equal(run.rawAnswer, original);
  assert.equal(f.saved.length, 0);
});

test("a broken schematic cannot swallow reviewer prose during repair", async () => {
  const original = "The verdict.\n\n```schematic\n{\"nodes\": []}\n\nOnly land after checking the retry.\n```";
  const f = fixture();
  const ask = f.deps.askPi;
  f.deps.askPi = (...args) => args[2] === "review-synthesis" ? Promise.resolve(args[1] === "review-synthesis" ? original : assignment) : ask(...args);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
  await settled(run);
  assert.equal(run.status, "invalid");
  assert.equal(run.rawAnswer, original);
  assert.equal(f.saved.length, 0);
});

test("a clean scan still needs a visual beneath the general verdict", async () => {
  const f = fixture();
  const ask = f.deps.askPi;
  f.deps.askPi = (...args) => args[2] === "review-synthesis" ? Promise.resolve("Ready to land. No regression.") : ask(...args);
  const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
  await settled(run);
  assert.equal(run.status, "invalid");
  assert.match(run.error!, /visual/i);
  assert.equal(f.saved.length, 0);
});

for (const repair of ["## Focus areas\nNo focus areas found.", new Error("repair unavailable")]) {
  test(`diagram repair preserves the original finding and diagnostics: ${repair instanceof Error ? "error" : "dropped finding"}`, async () => {
    const original = "## Focus areas\n### Makefile:2 — build stops\nBuild exits early.\n### Evidence\nConfirmed on base and HEAD.";
    const f = fixture();
    const ask = f.deps.askPi;
    f.deps.askPi = async (...args) => {
      if (args[2] !== "review-verify") return ask(...args);
      if (args[1] === "review-verify") return original;
      if (repair instanceof Error) throw repair;
      return repair;
    };
    const { run } = await createAnalysisApi(f.deps).start({ prKey: "pr", headSha: "head", kind: "main-review" });
    await settled(run);
    assert.equal(run.rawAnswer, original);
    assert.equal(f.saved.length, 0);
    assert.equal(run.status, repair instanceof Error ? "failed" : "invalid");
  });
}
