import assert from "node:assert/strict";
import test from "node:test";

import { withTtlCache } from "../../src/ttl-cache.js";

test("withTtlCache reuses in-flight and recent results per key", async () => {
  let calls = 0;
  const cached = withTtlCache(async (key: string) => {
    calls += 1;
    return `${key}:${calls}`;
  }, (key) => key, 60_000);

  const [first, second] = await Promise.all([cached("a"), cached("a")]);
  assert.equal(first, "a:1");
  assert.equal(second, "a:1");
  assert.equal(await cached("a"), "a:1");
  assert.equal(await cached("b"), "b:2");
  assert.equal(calls, 2);
});

test("withTtlCache does not cache failures", async () => {
  let calls = 0;
  const cached = withTtlCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return "ok";
  }, () => "k", 60_000);

  await assert.rejects(cached(), /boom/);
  assert.equal(await cached(), "ok");
  assert.equal(calls, 2);
});

test("refresh bypasses and replaces the cache, even while an older request is in flight", async () => {
  let calls = 0;
  let rejectOld!: (error: Error) => void;
  const cached = withTtlCache(async () => {
    calls++;
    if (calls === 1) return new Promise<string>((_resolve, reject) => { rejectOld = reject; });
    if (calls === 3) throw new Error("refresh failed");
    return `head-${calls}`;
  }, () => "pr", 60_000);
  const old = cached();
  const oldFailure = assert.rejects(old, /stale request failed/);
  assert.equal(await cached.refresh(), "head-2");
  rejectOld(new Error("stale request failed"));
  await oldFailure;
  assert.equal(await cached(), "head-2");
  await assert.rejects(cached.refresh(), /refresh failed/);
  assert.equal(await cached(), "head-4");
});

test("withTtlCache with ttl 0 is a pass-through", async () => {
  let calls = 0;
  const cached = withTtlCache(async () => {
    calls += 1;
    return calls;
  }, () => "k", 0);

  assert.equal(await cached(), 1);
  assert.equal(await cached(), 2);
});
