import assert from "node:assert/strict";
import test from "node:test";

import { createPiJobRunner } from "../../src/pi-jobs.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("Pi job runner starts running jobs and records successful completion", async () => {
  const calls: Array<[string, string, string | undefined]> = [];
  const runner = createPiJobRunner(async (prKey, prompt, purpose) => {
    calls.push([prKey, prompt, purpose]);
    return "done";
  }, { newId: () => "job-1", now: () => "2026-06-04T00:00:00.000Z" });

  const job = runner.startJob("github.com/pytorch/pytorch#1", "review this", "main-review");
  assert.deepEqual(job, { id: "job-1", prKey: "github.com/pytorch/pytorch#1", purpose: "main-review", status: "running", startedAt: "2026-06-04T00:00:00.000Z" });
  assert.deepEqual(calls, [["github.com/pytorch/pytorch#1", "review this", "main-review"]]);

  await flushMicrotasks();
  assert.deepEqual(runner.getJob("job-1"), { id: "job-1", prKey: "github.com/pytorch/pytorch#1", purpose: "main-review", status: "complete", answer: "done", startedAt: "2026-06-04T00:00:00.000Z", finishedAt: "2026-06-04T00:00:00.000Z" });
});

test("Pi job runner records failures without throwing from start", async () => {
  const runner = createPiJobRunner(async () => {
    throw new Error("model failed");
  }, { newId: () => "job-2", now: () => "2026-06-04T00:00:00.000Z" });

  const job = runner.startJob("github.com/pytorch/pytorch#1", "review this", "focus-review");
  assert.equal(job.status, "running");

  await flushMicrotasks();
  assert.deepEqual(runner.getJob("job-2"), { id: "job-2", prKey: "github.com/pytorch/pytorch#1", purpose: "focus-review", status: "failed", error: "model failed", startedAt: "2026-06-04T00:00:00.000Z", finishedAt: "2026-06-04T00:00:00.000Z" });
});

test("Pi job runner returns null for unknown jobs", () => {
  const runner = createPiJobRunner(async () => "done");
  assert.equal(runner.getJob("missing"), null);
});
