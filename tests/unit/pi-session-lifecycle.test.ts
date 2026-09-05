import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { askPi, disposePiSession, piActivity, piFinalAssistantAnswer, piSessionCwd, registerPiSessionContext } from "../../src/pi-session.js";

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

test("PR work requires registration, failed creation is evicted, global memory distillation remains explicit", async (t) => {
  const runtime = t.mock.method(ModelRuntime, "create", async () => { throw new Error("catalog unavailable"); });
  try {
    await assert.rejects(askPi(key, "unregistered"), /Open this pull request/);
    assert.equal(runtime.mock.callCount(), 0);
    await registerPiSessionContext(key, "/tmp/pi-review-lifecycle", { headSha: "new", files: [] });
    await assert.rejects(askPi(key, "first attempt"), /catalog unavailable/);
    await assert.rejects(askPi(key, "retry creation"), /catalog unavailable/);
    assert.equal(runtime.mock.callCount(), 2);
    await assert.rejects(askPi("review-memory", "distill", "review-memory-distill"), /catalog unavailable/);
    assert.equal(runtime.mock.callCount(), 3);
    await assert.rejects(askPi("review-memory", "chat"), /Open this pull request/);
  } finally {
    await disposePiSession(key);
    await disposePiSession("review-memory");
  }
});
