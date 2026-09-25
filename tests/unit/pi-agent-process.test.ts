import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { PiAgentProcess, PiAgentStartupError } from "../../src/pi-agent-process.js";
import { piFinalAssistantAnswer } from "../../src/pi-session.js";
import { createPiToolBridge } from "../../src/pi-tool-bridge.js";

// Keep the developer's machine-local launcher/model overrides out of these hermetic tests.
process.env.PI_REVIEW_LOCAL_CONFIG = "/nonexistent/.pi-review.local.json";

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

for (const mode of ["exit", "timer", "probe"] as const) {
  test(`headless ${mode} cleanup cannot throw SIGKILL errors from event callbacks`, { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-signal-error-"));
    const command = fileURLToPath(new URL("../fixtures/pi-rpc.mjs", import.meta.url));
    await chmod(command, 0o755);
    const previous = process.env.PI_REVIEW_PI_COMMAND;
    process.env.PI_REVIEW_PI_COMMAND = command;
    t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-6-astra" }));
    let session: PiAgentProcess | undefined;
    try {
      session = await PiAgentProcess.create({ cwd: root, sessionDir: root, thinkingLevel: "low", customTools: [] });
      const internal = session as unknown as { child: { pid?: number }; signal: (signal: NodeJS.Signals) => void; exited: Promise<void> };
      const originalSignal = internal.signal.bind(session);
      const signals: string[] = [];
      const signalMock = t.mock.method(internal, "signal", (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        if (mode !== "timer") originalSignal(signal);
      });
      try {
        if (mode === "exit") {
          await assert.rejects(session.prompt("exit"), /exited \(7\)/);
          await session.dispose();
          assert.equal(signals.includes("SIGKILL"), false);
        } else if (mode === "timer") {
          await assert.rejects(session.dispose(), /EPERM/);
          assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        } else {
          const pid = internal.child.pid;
          assert.ok(pid != null && pid > 1);
          const kill = process.kill.bind(process);
          const destructiveSignals: unknown[] = [];
          const probe = t.mock.method(process, "kill", (target, signal) => {
            if (target === -pid) {
              if (signal === 0) throw Object.assign(new Error("probe EPERM"), { code: "EPERM" });
              assert.equal(destructiveSignals.length, 0, "must not signal a reaped process group");
              destructiveSignals.push(signal);
            }
            return kill(target, signal);
          });
          try {
            await assert.rejects(session.dispose(), new RegExp(`group ${pid} cleanup is unverified: probe EPERM`));
            originalSignal("SIGKILL"); // Exercise the real post-exit guard, without permitting an OS signal.
            assert.deepEqual(destructiveSignals, ["SIGTERM"]);
          } finally { probe.mock.restore(); }
        }
      } finally {
        signalMock.mock.restore();
        originalSignal("SIGTERM");
        await internal.exited;
        await session.dispose(); // Retry must verify cleanup after the injected denial.
      }
    } finally {
      if (previous == null) delete process.env.PI_REVIEW_PI_COMMAND;
      else process.env.PI_REVIEW_PI_COMMAND = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("startup and cleanup failures preserve both causes and the owned process for retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-startup-error-"));
  const command = fileURLToPath(new URL("../fixtures/pi-rpc.mjs", import.meta.url));
  await chmod(command, 0o755);
  const previous = process.env.PI_REVIEW_PI_COMMAND;
  process.env.PI_REVIEW_PI_COMMAND = command;
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "missing-extension" }));
  let owned: PiAgentProcess | undefined;
  const denied = t.mock.method(PiAgentProcess.prototype, "dispose", async function (this: PiAgentProcess) {
    owned = this;
    throw new Error("cleanup denied");
  });
  try {
    await assert.rejects(PiAgentProcess.create({ cwd: root, sessionDir: root, thinkingLevel: "low", customTools: [] }), (error: unknown) => {
      assert.ok(error instanceof PiAgentStartupError);
      assert.match(error.message, /tool extension did not initialize/);
      assert.match(error.message, /cleanup denied/);
      assert.equal(error.session, owned);
      assert.equal(error.errors.length, 2);
      assert.equal(JSON.stringify(error), "{}"); // Never serialize the process/bridge credentials.
      return true;
    });
  } finally {
    denied.mock.restore();
    await owned?.dispose();
    if (previous == null) delete process.env.PI_REVIEW_PI_COMMAND;
    else process.env.PI_REVIEW_PI_COMMAND = previous;
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
  const barrier = bridge.close();
  assert.equal(bridge.close(), barrier);
  const closing = barrier.then(() => { closed = true; });
  try {
    await delay(10);
    assert.equal(closed, false);
  } finally {
    finish();
    await closing;
    await request;
  }
  assert.equal(closed, true);
  await bridge.close();
});
