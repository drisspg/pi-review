import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { PiAgentProcess } from "../../src/pi-agent-process.js";
import { piFinalAssistantAnswer } from "../../src/pi-session.js";
import { createPiToolBridge } from "../../src/pi-tool-bridge.js";

test("launcher-backed agents stream through retries, call server-owned tools, switch models, abort, and reject exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-process-"));
  const command = fileURLToPath(new URL("../fixtures/pi-rpc.mjs", import.meta.url));
  await chmod(command, 0o755);
  const previous = process.env.PI_REVIEW_PI_COMMAND;
  process.env.PI_REVIEW_PI_COMMAND = command;
  let defaultModel = "gpt-6-astra";
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "openai", defaultModel }));
  const calls: string[] = [];
  let session: PiAgentProcess | undefined;
  try {
    session = await PiAgentProcess.create({ cwd: root, sessionDir: root, thinkingLevel: "low", tools: ["echo"], customTools: [{
      name: "echo", label: "Echo", description: "Echo test values", parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) { calls.push(params.value); return { content: [{ type: "text", text: params.value }], details: {} }; },
    }] });
    assert.equal(session.model?.provider, "openai");
    assert.deepEqual(session.getActiveToolNames(), ["echo"]);
    const events: string[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event.type));
    const text = "café\u2028still one record\u2029yes";
    await session.prompt(text);
    assert.deepEqual(calls, [text]);
    assert.equal(piFinalAssistantAnswer(session.messages), text);
    assert.equal(events.filter((type) => type === "agent_end").length, 2);
    assert.ok(events.includes("tool_execution_end"));
    assert.ok(events.includes("message_update"));
    assert.equal(session.isStreaming, false);
    await session.prompt("second turn");
    assert.equal(piFinalAssistantAnswer(session.messages), "second turn");
    await session.prompt("/handled");
    assert.throws(() => piFinalAssistantAnswer(session!.messages), /without assistant text/);
    await session.setModel("anthropic", "claude-fable-5-1");
    await session.setThinkingLevel("high");
    assert.equal(session.model?.provider, "anthropic");
    assert.equal(session.thinkingLevel, "high");
    assert.deepEqual(await session.getAvailableThinkingLevels(), ["off", "low", "high"]);
    assert.equal((await session.getAvailableModels())[0].provider, "anthropic");
    const hanging = session.prompt("hang");
    await session.abort();
    await hanging;
    assert.throws(() => piFinalAssistantAnswer(session!.messages), /aborted/);
    await assert.rejects(session.prompt("exit"), /exited \(7\)/);
    assert.equal(session.closed, true);
    unsubscribe();
    await session.dispose();
    await session.dispose();
    for (const [model, expected] of [["missing-extension", /tool extension did not initialize/], ["fallback", /refusing a fallback/]] as const) {
      defaultModel = model;
      await assert.rejects(PiAgentProcess.create({ cwd: root, sessionDir: root, thinkingLevel: "low", customTools: [] }), expected);
    }
    process.env.PI_REVIEW_PI_COMMAND = join(root, "missing-command");
    await assert.rejects(PiAgentProcess.create({ cwd: root, sessionDir: root, thinkingLevel: "low", customTools: [] }), /ENOENT/);
  } finally {
    if (previous == null) delete process.env.PI_REVIEW_PI_COMMAND;
    else process.env.PI_REVIEW_PI_COMMAND = previous;
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("tool bridge rejects unauthenticated and browser requests, and surfaces tool errors", async () => {
  const bridge = await createPiToolBridge([{
    name: "fail", label: "Fail", description: "Fail", parameters: Type.Object({}),
    async execute() { throw new Error("tool failure"); },
  }]);
  const url = bridge.env.PI_REVIEW_TOOL_URL;
  const authorization = `Bearer ${bridge.env.PI_REVIEW_TOOL_TOKEN}`;
  try {
    assert.equal((await fetch(`${url}/tools`)).status, 403);
    assert.equal((await fetch(`${url}/tools`, { headers: { authorization, origin: "http://localhost" } })).status, 403);
    const response = await fetch(`${url}/execute`, { method: "POST", headers: { authorization }, body: JSON.stringify({ name: "fail", id: "1", params: {} }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "tool failure" });
  } finally {
    await bridge.close();
  }
});

test("tool bridge shutdown waits for server-side state mutations after client cancellation", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const mutation = new Promise<void>((resolve) => { finish = resolve; });
  const bridge = await createPiToolBridge([{
    name: "write_draft", label: "Write draft", description: "Test delayed commit", parameters: Type.Object({}),
    async execute() { started(); await mutation; return { content: [], details: {} }; },
  }]);
  const request = fetch(`${bridge.env.PI_REVIEW_TOOL_URL}/execute`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.env.PI_REVIEW_TOOL_TOKEN}` },
    body: JSON.stringify({ name: "write_draft", id: "1", params: {} }),
  }).catch(() => undefined);
  await running;
  let closed = false;
  const closing = bridge.close().then(() => { closed = true; });
  try {
    await delay(10);
    assert.equal(closed, false);
  } finally {
    finish();
    await closing;
    await request;
  }
  assert.equal(closed, true);
});
