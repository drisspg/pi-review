import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { assertLegacyTransition, createCheckoutCache, ownCheckoutCache } from "../../src/checkout-cache.js";
import { checkoutCacheRoot, legacyStorageRoot, reviewSessionRoot, reviewStatePath } from "../../src/storage-paths.js";

const home = "/home/reviewer";
test("cache roots follow platform conventions and explicit settings", () => {
  assert.equal(checkoutCacheRoot({}, "darwin", home), `${home}/Library/Caches/pi-review`);
  assert.equal(checkoutCacheRoot({}, "linux", home), `${home}/.cache/pi-review`);
  assert.equal(checkoutCacheRoot({ XDG_CACHE_HOME: "/cache" }, "linux", home), "/cache/pi-review");
  assert.equal(checkoutCacheRoot({ LOCALAPPDATA: "/local" }, "win32", home), "/local/pi-review/Cache");
  assert.equal(checkoutCacheRoot({ PI_REVIEW_CACHE_DIR: "/explicit", PI_REVIEW_STATE_PATH: "/state.json" }, "darwin", home), "/explicit");
  assert.throws(() => checkoutCacheRoot({ PI_REVIEW_CACHE_DIR: "" }), /must not be empty/);
});

test("durable state defaults remain unchanged; custom state isolates checkouts and sessions", () => {
  assert.equal(reviewStatePath({}, home), `${legacyStorageRoot(home)}/state.json`);
  assert.equal(reviewSessionRoot({}, home), legacyStorageRoot(home));
  const explicitDefault = { PI_REVIEW_STATE_PATH: reviewStatePath({}, home) };
  assert.equal(reviewSessionRoot(explicitDefault, home), legacyStorageRoot(home));
  assert.equal(checkoutCacheRoot(explicitDefault, "darwin", home), `${home}/Library/Caches/pi-review`);
  assert.equal(reviewStatePath({ PI_REVIEW_CACHE_DIR: "/cache" }, home), `${legacyStorageRoot(home)}/state.json`);
  for (const name of ["one", "two"]) {
    const env = { PI_REVIEW_STATE_PATH: `/tmp/${name}.json` };
    assert.equal(reviewStatePath(env, home), `/tmp/${name}.json`);
    assert.equal(checkoutCacheRoot(env, "darwin", home), `/tmp/${name}.json.cache`);
    assert.equal(reviewSessionRoot(env, home), `/tmp/${name}.json.data`);
  }
});

test("cache ownership rejects sharing and requires explicit stale lock recovery", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-review-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = ownCheckoutCache(root);
  assert.throws(() => ownCheckoutCache(root), /owned/);
  release();
  const releaseAgain = ownCheckoutCache(root);
  releaseAgain();
  await mkdir(resolve(root, ".checkout-owner"));
  await writeFile(resolve(root, ".checkout-owner/owner.json"), '{"pid":999999999}');
  assert.throws(() => ownCheckoutCache(root), /manual lock recovery/);
});

test("lock release tolerates a removed lock and cannot remove a replacement owner", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-review-lock-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = ownCheckoutCache(root);
  await rm(resolve(root, ".checkout-owner"), { recursive: true });
  const second = ownCheckoutCache(root);
  first();
  assert.match(await readFile(resolve(root, ".checkout-owner/owner.json"), "utf8"), /token/);
  await rm(resolve(root, ".checkout-owner"), { recursive: true });
  assert.doesNotThrow(second);
});

test("Finder metadata is retained but does not block inventory or the legacy transition", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "pi-review-finder-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = legacyStorageRoot(home);
  await mkdir(resolve(root, "repos"), { recursive: true });
  await writeFile(resolve(root, "repos/.DS_Store"), "Finder data");
  await assertLegacyTransition({}, home);
  const cache = createCheckoutCache(root, { users: async () => [], git: async () => { throw new Error("must not inspect Finder data"); } });
  assert.deepEqual((await cache.inventory()).entries, []);
  await writeFile(resolve(root, "repos/unexpected.txt"), "preserve me");
  const entry = (await cache.inventory()).entries[0];
  assert.match(entry.reasons[0], /unexpected cache layout/);
  await assert.rejects(cache.evict(entry.id, true), /unexpected cache layout/);
  assert.equal(await readFile(resolve(root, "repos/.DS_Store"), "utf8"), "Finder data");
  assert.equal(await readFile(resolve(root, "repos/unexpected.txt"), "utf8"), "preserve me");
});

test("legacy transition inventories without moving durable data or creating a second cache", async (t) => {
  const home = await mkdtemp(resolve(tmpdir(), "pi-review-legacy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const legacy = legacyStorageRoot(home);
  await mkdir(resolve(legacy, "repos/github.com/owner/repo"), { recursive: true });
  await writeFile(resolve(legacy, "state.json"), "durable review history");
  await assert.rejects(assertLegacyTransition({}, home), /Legacy checkouts remain/);
  assert.equal(await readFile(resolve(legacy, "state.json"), "utf8"), "durable review history");
  await rm(resolve(legacy, "repos/github.com/owner/repo"), { recursive: true });
  await assertLegacyTransition({}, home);
});

test("isolated instances never inspect legacy production storage", async () => {
  await assertLegacyTransition({ PI_REVIEW_STATE_PATH: "/tmp/isolated.json" });
  await assertLegacyTransition({ PI_REVIEW_CACHE_DIR: "/tmp/explicit-cache" });
});
