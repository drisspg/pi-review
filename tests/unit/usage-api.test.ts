import assert from "node:assert/strict";
import test from "node:test";

import { createUsageApi, defaultUsageLogPath, type UsageApiDeps } from "../../src/usage-api.js";

function fakeDeps(overrides: Partial<UsageApiDeps> = {}): UsageApiDeps & { lines: string[]; errors: unknown[] } {
  const lines: string[] = [];
  const errors: unknown[] = [];
  return {
    lines,
    errors,
    async appendLine(line: string) {
      lines.push(line);
    },
    logPath: "/tmp/usage.jsonl",
    now: () => "2026-08-29T00:00:00.000Z",
    onError: (error: unknown) => {
      errors.push(error);
    },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("record appends one JSONL line per event in order", async () => {
  const deps = fakeDeps();
  const api = createUsageApi(deps);

  api.record("server", "/api/pr/open", { method: "POST", status: 200, ms: 12 });
  api.record("web", "ui:side-tab", { tab: "pi" });
  api.record("server", "server:start");
  await settle();

  assert.deepEqual(deps.lines.map((line) => JSON.parse(line)), [
    { ts: "2026-08-29T00:00:00.000Z", source: "server", name: "/api/pr/open", data: { method: "POST", status: 200, ms: 12 } },
    { ts: "2026-08-29T00:00:00.000Z", source: "web", name: "ui:side-tab", data: { tab: "pi" } },
    { ts: "2026-08-29T00:00:00.000Z", source: "server", name: "server:start" },
  ]);
  assert.ok(deps.lines.every((line) => line.endsWith("\n")));
});

test("record swallows append failures and reports the first one only", async () => {
  const deps = fakeDeps({
    async appendLine() {
      throw new Error("disk full");
    },
  });
  const api = createUsageApi(deps);

  api.record("server", "a");
  api.record("server", "b");
  await settle();

  assert.equal(deps.errors.length, 1);
  assert.equal((deps.errors[0] as Error).message, "disk full");
});

test("recordClientEvents validates and records web events", async () => {
  const deps = fakeDeps();
  const api = createUsageApi(deps);

  const result = api.recordClientEvents({
    events: [
      { name: "ui:theme", data: { theme: "github-light" } },
      { name: "ui:diff-view-mode" },
      { name: "" },
      { name: 42 },
      { name: "bad-data", data: [1, 2] },
      "junk",
    ],
  });
  await settle();

  assert.equal(result.recorded, 3);
  assert.deepEqual(deps.lines.map((line) => JSON.parse(line) as { source: string; name: string }).map(({ source, name }) => ({ source, name })), [
    { source: "web", name: "ui:theme" },
    { source: "web", name: "ui:diff-view-mode" },
    { source: "web", name: "bad-data" },
  ]);
  assert.equal((JSON.parse(deps.lines[2]) as { data?: unknown }).data, undefined);
});

test("recordClientEvents rejects payloads without an events array and caps batches", async () => {
  const deps = fakeDeps();
  const api = createUsageApi(deps);

  assert.throws(() => api.recordClientEvents({}), /Expected events array/);

  const result = api.recordClientEvents({ events: Array.from({ length: 80 }, (_, index) => ({ name: `e${index}` })) });
  await settle();
  assert.equal(result.recorded, 50);
  assert.equal(deps.lines.length, 50);
});

test("defaultUsageLogPath follows env overrides and the state file location", () => {
  assert.equal(defaultUsageLogPath({ PI_REVIEW_USAGE_LOG_PATH: "/tmp/custom.jsonl" }), "/tmp/custom.jsonl");
  assert.equal(defaultUsageLogPath({ PI_REVIEW_STATE_PATH: "/tmp/e2e-state-43134.json" }), "/tmp/e2e-state-43134.usage.jsonl");
  assert.ok(defaultUsageLogPath({}).endsWith("/.pi/agent/state/pi-pr-review/state.usage.jsonl"));
});
