import assert from "node:assert/strict";
import test from "node:test";

import { createPreReviewAssessor, formatPreReviewEvidence, type PreReviewAssessorDeps } from "../../src/pre-review-assessor.js";
import type { PytorchPreReviewEvidence } from "../../src/types.js";

function evidence(number: number): PytorchPreReviewEvidence {
  return { number, title: `PR ${number}`, url: "", author: "alice", authorPermission: "read", body: "Fixes #9", labels: ["triaged"], createdAt: "2026-09-01T00:00:00Z", updatedAt: `2026-09-0${number}T00:00:00Z`, additions: 1, deletions: 0, changedFiles: 1, files: [{ path: "a.py", additions: 1, deletions: 0 }], reviews: [{ author: "bob", at: "2026-09-02T00:00:00Z", body: "too large", state: "CHANGES_REQUESTED" }], comments: [], linkedIssues: [{ number: 9, title: "bug", state: "CLOSED", labels: ["triaged"], body: "repro", comments: [{ author: "eve", at: "2026-09-03T00:00:00Z", body: "fixed on main" }] }] };
}

function harness(overrides: Partial<PreReviewAssessorDeps> = {}) {
  let candidates = [{ number: 1, updatedAt: "a" }, { number: 2, updatedAt: "b" }];
  const timers: Array<() => void> = [];
  const saved: Array<{ number: number; markdown: string; prUpdatedAt: string; source: string }> = [];
  let now = Date.parse("2026-09-10T00:00:00Z");
  let concurrent = 0;
  let maxConcurrent = 0;
  const deps: PreReviewAssessorDeps = {
    enabled: true,
    source: "Astra",
    listCandidates: async () => candidates,
    gatherEvidence: async (number) => evidence(number),
    buildPrompt: async (item) => `prompt ${item.number}`,
    runModel: async (prompt) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return `Recommendation: Accept (${prompt})`;
    },
    save: async (input) => {
      saved.push(input);
      candidates = candidates.filter((candidate) => candidate.number !== input.number);
    },
    now: () => new Date(now).toISOString(),
    setTimer: (callback) => {
      timers.push(callback);
      return () => {
        const index = timers.indexOf(callback);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    ...overrides,
  };
  const assessor = createPreReviewAssessor(deps);
  async function fire(): Promise<void> {
    const callback = timers.shift();
    assert.ok(callback, "expected a scheduled tick");
    callback();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }
  return { assessor, deps, saved, timers, fire, setCandidates: (next: typeof candidates) => { candidates = next; }, advance: (ms: number) => { now += ms; }, maxConcurrent: () => maxConcurrent };
}

test("walks owed pre-reviews top first, one at a time, saving advisory suggestions until caught up", async () => {
  const h = harness();
  h.assessor.start();
  await h.fire();
  await h.fire();
  assert.deepEqual(h.saved.map((item) => [item.number, item.source, item.prUpdatedAt]), [[1, "Astra", "2026-09-01T00:00:00Z"], [2, "Astra", "2026-09-02T00:00:00Z"]]);
  assert.match(h.saved[0].markdown, /prompt 1/);
  assert.equal(h.maxConcurrent(), 1);
  await h.fire();
  assert.deepEqual(h.assessor.status(), { enabled: true, source: "Astra", current: null, pending: 0, completed: 2, lastError: null });
  assert.equal(h.timers.length, 1, "caught up: one idle recheck stays scheduled");
});

test("a failing PR is reported, skipped until its retry window, and does not block the rest", async () => {
  let fail = true;
  const h = harness({ gatherEvidence: async (number) => {
    if (number === 1 && fail) throw new Error("gh: HTTP 502");
    return evidence(number);
  } });
  h.assessor.start();
  await h.fire();
  assert.deepEqual(h.assessor.status().lastError, { number: 1, message: "gh: HTTP 502", at: "2026-09-10T00:00:00.000Z" });
  await h.fire();
  assert.deepEqual(h.saved.map((item) => item.number), [2]);
  fail = false;
  await h.fire();
  assert.deepEqual(h.saved.map((item) => item.number), [2], "still inside the retry window");
  h.advance(31 * 60 * 1000);
  await h.fire();
  assert.deepEqual(h.saved.map((item) => item.number), [2, 1]);
});

test("stop aborts the in-flight model run and nothing is saved afterwards", async () => {
  let aborted = false;
  const h = harness({ runModel: (_prompt, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    });
  }) });
  h.assessor.start();
  const tick = h.timers.shift();
  tick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.assessor.status().current?.number, 1);
  await h.assessor.stop();
  assert.equal(aborted, true);
  assert.deepEqual(h.saved, []);
  assert.equal(h.timers.length, 0);
  assert.equal(h.assessor.status().enabled, false);
});

test("a disabled assessor never schedules work", () => {
  const h = harness({ enabled: false });
  h.assessor.start();
  h.assessor.poke();
  assert.equal(h.timers.length, 0);
  assert.equal(h.assessor.status().enabled, false);
});

test("evidence rendering carries the facts a tool-less model needs for the pre-conditions and direction", () => {
  const text = formatPreReviewEvidence(evidence(1));
  assert.match(text, /alice \(repo permission: read\)/);
  assert.match(text, /#9 bug \(CLOSED; labels: triaged\)/);
  assert.match(text, /bob \[CHANGES_REQUESTED\] 2026-09-02: too large/);
  assert.match(text, /eve 2026-09-03: fixed on main/);
});

test("explicit requests share the single lane with background runs and work with the background loop off", async () => {
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const h = harness({ runModel: async (prompt) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    order.push(Number(prompt.split(" ")[1]));
    return "Recommendation: Accept";
  } });
  h.assessor.start();
  h.timers.shift()?.();
  await h.assessor.assessNow(7);
  assert.equal(peak, 1, "never two model runs at once");
  assert.deepEqual(order, [1, 7], "the request waits for the in-flight background run");

  const off = harness({ enabled: false });
  await off.assessor.assessNow(5);
  assert.deepEqual(off.saved.map((item) => item.number), [5]);
  assert.equal(off.timers.length, 0, "an explicit request does not start the background loop");
});

test("evidence includes a size-capped diff so the model sees the shape of the change without a checkout", () => {
  const big = { ...evidence(1), files: [{ path: "a.py", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-old\n+new" }, { path: "huge.cpp", additions: 9000, deletions: 0, patch: "+x\n".repeat(5000) }, { path: "img.png", additions: 0, deletions: 0 }] };
  const text = formatPreReviewEvidence(big);
  assert.match(text, /### a\.py\n```diff\n@@ -1 \+1 @@\n-old\n\+new\n```/);
  assert.match(text, /### huge\.cpp[\s\S]*\(truncated\)/);
  assert.ok(text.length < 40_000);
  assert.doesNotMatch(text, /### img\.png/);
});
