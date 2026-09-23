import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PiAgentProcess, PiAgentStartupError } from "../../src/pi-agent-process.js";

import { askPi, disposePiSession, disposePiSessions, piActivity, piFinalAssistantAnswer, piSessionCwd, prewarmPiSession, registerPiSessionContext } from "../../src/pi-session.js";

const key = "github.com/org/repo#123";

/** Model messages are the settled contract, unlike streamed commentary. */
function assistant(text: string, stopReason = "stop", errorMessage?: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage };
}

test("final assistant result excludes commentary and recovers from earlier model errors", () => {
  assert.equal(piFinalAssistantAnswer([
    assistant("Investigating", "toolUse"),
    assistant("", "error", "rate limited"),
    { role: "toolResult", content: "result" },
    assistant("Final artifact"),
  ]), "Final artifact");
  assert.throws(() => piFinalAssistantAnswer([assistant("earlier"), assistant("", "error", "failed")]), /Pi model error: failed/);
  assert.throws(() => piFinalAssistantAnswer([assistant("partial", "aborted")]), /aborted/);
  assert.throws(() => piFinalAssistantAnswer([assistant("earlier"), assistant("")]), /without assistant text/);
  assert.throws(() => piFinalAssistantAnswer([]), /without assistant text/);
});

test("disposal invalidates queued work before it can create a fallback session", async () => {
  await registerPiSessionContext(key, "/tmp/pi-review-lifecycle", { headSha: "old", files: [] });
  const first = askPi(key, "first");
  const second = askPi(key, "second");
  const results = Promise.allSettled([first, second]);
  await disposePiSession(key);
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(String(result.reason), /invalidated/);
  }
  assert.equal(piSessionCwd(key), null);
  assert.equal((await piActivity(key)).status, "idle");
});

for (const failure of ["abort", "dispose"] as const) {
  test(`failed headless ${failure} stays a registration barrier until cleanup succeeds on retry`, async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "pi-review-disposal-retry-"));
    const previousStatePath = process.env.PI_REVIEW_STATE_PATH;
    process.env.PI_REVIEW_STATE_PATH = resolve(root, "state.json");
    const prKey = `github.com/org/repo#${failure === "abort" ? 124 : 125}`;
    let ready!: () => void;
    const created = new Promise<void>((done) => { ready = done; });
    let safe = false, attempts = 0;
    const session = {
      model: null, closed: false,
      async abort() { if (!this.closed && failure === "abort" && !safe) throw new Error("abort failed"); },
      async dispose() { attempts++; this.closed = true; if (failure === "dispose" && !safe) throw new Error("kill EPERM"); },
    };
    t.mock.method(PiAgentProcess, "create", async () => { ready(); return session as never; });
    try {
      await registerPiSessionContext(prKey, root, { headSha: "old", files: [] });
      prewarmPiSession(prKey, ["main-review"]);
      await created;
      await assert.rejects(disposePiSession(prKey), failure === "abort" ? /abort failed/ : /EPERM/);
      await assert.rejects(registerPiSessionContext(prKey, root, { headSha: "new", files: [] }));
      assert.equal(piSessionCwd(prKey), null);
      await assert.rejects(askPi(prKey, "must not start"), /being disposed/);
      safe = true;
      const first = disposePiSession(prKey);
      const concurrent = disposePiSession(prKey);
      assert.equal(first, concurrent);
      await first;
      assert.equal(attempts, 2);
      assert.equal((await piActivity(prKey)).status, "idle");
      await registerPiSessionContext(prKey, root, { headSha: "new", files: [] });
      assert.equal(piSessionCwd(prKey), root);
    } finally {
      safe = true;
      await disposePiSession(prKey);
      if (previousStatePath == null) delete process.env.PI_REVIEW_STATE_PATH;
      else process.env.PI_REVIEW_STATE_PATH = previousStatePath;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const concurrent of [false, true]) {
  test(`failed startup retains its unverified process (concurrent disposal: ${concurrent})`, async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "pi-review-startup-cleanup-"));
    const previousStatePath = process.env.PI_REVIEW_STATE_PATH;
    process.env.PI_REVIEW_STATE_PATH = resolve(root, "state.json");
    const prKey = `github.com/org/repo#${concurrent ? 126 : 127}`;
    let started!: () => void, rejectStartup!: (error: Error) => void;
    const starting = new Promise<void>((done) => { started = done; });
    const startup = new Promise<never>((_, reject) => { rejectStartup = reject; });
    let safe = false;
    const session = {
      closed: true,
      async abort() {},
      async dispose() { if (!safe) throw new Error("cleanup denied"); },
    };
    const create = t.mock.method(PiAgentProcess, "create", async () => { started(); return startup; });
    try {
      await registerPiSessionContext(prKey, root, { headSha: "old", files: [] });
      const prompt = assert.rejects(askPi(prKey, "start"), /startup failed/);
      await starting;
      const disposal = concurrent ? assert.rejects(disposePiSession(prKey), /cleanup denied/) : null;
      rejectStartup(new PiAgentStartupError(session as never, new Error("bad model"), new Error("cleanup denied")));
      await prompt;
      if (disposal != null) await disposal;
      else {
        await assert.rejects(askPi(prKey, "retry"), /cleanup denied/);
        assert.equal(create.mock.callCount(), 1);
        await assert.rejects(disposePiSession(prKey), /cleanup denied/);
      }
      await assert.rejects(registerPiSessionContext(prKey, root, { headSha: "new", files: [] }), /cleanup denied/);
      safe = true;
      await disposePiSessions(); // Shutdown must also retry failed startup ownership.
      await registerPiSessionContext(prKey, root, { headSha: "new", files: [] });
      assert.equal(piSessionCwd(prKey), root);
    } finally {
      safe = true;
      await disposePiSession(prKey);
      if (previousStatePath == null) delete process.env.PI_REVIEW_STATE_PATH;
      else process.env.PI_REVIEW_STATE_PATH = previousStatePath;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("PR work requires registration, failed creation is evicted, global memory distillation remains explicit", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-review-session-lifecycle-"));
  const previousStatePath = process.env.PI_REVIEW_STATE_PATH;
  process.env.PI_REVIEW_STATE_PATH = resolve(root, "state.json");
  const runtime = t.mock.method(PiAgentProcess, "create", async () => { throw new Error("catalog unavailable"); });
  try {
    await assert.rejects(askPi(key, "unregistered"), /Open this pull request/);
    assert.equal(runtime.mock.callCount(), 0);
    await registerPiSessionContext(key, "/tmp/pi-review-lifecycle", { headSha: "new", files: [] });
    await assert.rejects(askPi(key, "first attempt"), /catalog unavailable/);
    await assert.rejects(askPi(key, "retry creation"), /catalog unavailable/);
    assert.equal(runtime.mock.callCount(), 2);
    assert.ok(runtime.mock.calls[0].arguments[0].sessionDir.startsWith(`${root}/state.json.data/`));
    assert.deepEqual(runtime.mock.calls[0].arguments[0].workspace, { prKey: key, root: "/tmp/pi-review-lifecycle", headSha: "new", scope: "chat", changedFiles: [] });
    await assert.rejects(askPi("review-memory", "distill", "review-memory-distill"), /catalog unavailable/);
    assert.equal(runtime.mock.callCount(), 3);
    assert.equal(runtime.mock.calls[2].arguments[0].workspace, undefined);
    await assert.rejects(askPi("review-memory", "chat"), /Open this pull request/);
  } finally {
    await disposePiSession(key);
    await disposePiSession("review-memory");
    if (previousStatePath == null) delete process.env.PI_REVIEW_STATE_PATH;
    else process.env.PI_REVIEW_STATE_PATH = previousStatePath;
    await rm(root, { recursive: true, force: true });
  }
});
