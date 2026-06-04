import assert from "node:assert/strict";
import test from "node:test";

import { createPiApi } from "../../src/pi-api.js";
import type { PiJob, PiJobRunner } from "../../src/pi-jobs.js";

const runningJob: PiJob = { id: "job-1", prKey: "pr", status: "running", startedAt: "now" };

function fakeDeps() {
  const calls: string[] = [];
  const runner: PiJobRunner = {
    getJob(jobId: string) {
      calls.push(`get:${jobId}`);
      return jobId === "job-1" ? runningJob : null;
    },
    startJob(prKey: string, prompt: string, purpose?: string) {
      calls.push(`start:${prKey}:${prompt}:${purpose}`);
      return { ...runningJob, prKey };
    },
  };
  return {
    calls,
    deps: {
      async askPi(prKey: string, prompt: string, purpose?: string) {
        calls.push(`ask:${prKey}:${prompt}:${purpose}`);
        return "answer";
      },
      async piDiagnostics(prKey: string) {
        calls.push(`diagnostics:${prKey}`);
        return { ok: true };
      },
      piJobRunner: runner,
      async setPiModel(prKey: string, provider: string, modelId: string, thinkingLevel?: string) {
        calls.push(`model:${prKey}:${provider}:${modelId}:${thinkingLevel}`);
        return { modelId };
      },
    },
  };
}

test("Pi API ask validates payload and delegates to askPi", async () => {
  const { deps, calls } = fakeDeps();

  assert.deepEqual(await createPiApi(deps).ask({ prKey: "pr", prompt: "prompt", purpose: "chat" }), { answer: "answer" });
  assert.deepEqual(calls, ["ask:pr:prompt:chat"]);
});

test("Pi API starts and reads review jobs", async () => {
  const { deps, calls } = fakeDeps();
  const api = createPiApi(deps);

  assert.deepEqual(await api.startReviewJob({ prKey: "pr", prompt: "prompt" }, "main-review"), { job: runningJob });
  assert.deepEqual(await api.jobStatus({ jobId: "job-1" }), { job: runningJob });
  assert.deepEqual(calls, ["start:pr:prompt:main-review", "get:job-1"]);
});

test("Pi API diagnostics and model routes delegate with validation", async () => {
  const { deps, calls } = fakeDeps();
  const api = createPiApi(deps);

  assert.deepEqual(await api.diagnostics({ prKey: "pr" }), { diagnostics: { ok: true } });
  assert.deepEqual(await api.setModel({ prKey: "pr", provider: "openai", modelId: "gpt", thinkingLevel: "low" }), { diagnostics: { modelId: "gpt" } });
  assert.deepEqual(calls, ["diagnostics:pr", "model:pr:openai:gpt:low"]);
});

test("Pi API rejects invalid payloads and unknown jobs", async () => {
  const api = createPiApi(fakeDeps().deps);

  await assert.rejects(api.ask({ prKey: "pr" }), /Expected prKey and prompt/);
  await assert.rejects(api.jobStatus({ jobId: "missing" }), /Unknown review job missing/);
  await assert.rejects(api.diagnostics({}), /Expected prKey/);
  await assert.rejects(api.setModel({ prKey: "pr", provider: "openai" }), /Expected prKey, provider, and modelId/);
});
