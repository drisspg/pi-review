import assert from "node:assert/strict";
import test from "node:test";

import { createPiTerminalApi } from "../../src/pi-terminal-api.js";

test("Pi terminal API validates and deletes a persisted session", async () => {
  const calls: Array<[string, string]> = [];
  const api = createPiTerminalApi({
    async deleteSession(prKey, session) {
      calls.push([prKey, session]);
    },
  });

  assert.deepEqual(await api.remove({ prKey: " github.com/org/repo#1 ", session: " inline-1 " }), { ok: true });
  assert.deepEqual(calls, [["github.com/org/repo#1", "inline-1"]]);
  await assert.rejects(() => api.remove({ prKey: "pr" }), /Expected terminal prKey and session/);
});
