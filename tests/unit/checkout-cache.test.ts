import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { CACHE_LOCK, cacheGit, createCheckoutCache, ownCheckoutCache } from "../../src/checkout-cache.js";
import { createWorktreeService } from "../../src/worktrees.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "fixture", repo: "project", number: 1 };
const runtime = { git: cacheGit, users: async () => [] as string[] };
const commitOptions = ["-c", "user.name=Cache Test", "-c", "user.email=cache-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

async function commit(cwd: string, message: string): Promise<string> {
  await cacheGit([...commitOptions, "commit", "-m", message], cwd);
  return cacheGit(["rev-parse", "HEAD"], cwd);
}

async function initRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await cacheGit(["init", "--initial-branch=main", "--template="], path);
  await writeFile(resolve(path, "README.md"), "base content\n");
  await writeFile(resolve(path, ".gitignore"), "ignored.log\n");
  await cacheGit(["add", "."], path);
  await commit(path, "Initial commit");
}

async function fixture(t: TestContext) {
  // Canonicalize /var on macOS so Git's worktree paths match the fixture paths.
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "pi-review-checkout-cache-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = resolve(directory, "storage");
  const origin = resolve(directory, "origin");
  await initRepository(origin);
  await cacheGit(["checkout", "--detach"], origin);
  await writeFile(resolve(origin, "README.md"), "PR content\n");
  await cacheGit(["add", "README.md"], origin);
  const head = await commit(origin, "PR-only commit");
  await cacheGit(["update-ref", "refs/pull/1/head", head], origin);
  await cacheGit(["checkout", "main"], origin);

  const service = createWorktreeService({
    exists: existsSync,
    git: (args, cwd) => cacheGit(args[0] === "clone" ? ["clone", "--template=", ...args.slice(1)] : args, cwd ?? directory),
    async mkdir(path) { await mkdir(path, { recursive: true }); },
  }, root);
  const release = ownCheckoutCache(root);
  try {
    await service.preparePrWorktree(ref, origin, head);
  } finally {
    release();
  }

  // Legacy storage can colocate durable state/sessions with disposable checkouts.
  const state = resolve(root, "state.json");
  const session = resolve(root, "pi-sessions", "review.jsonl");
  await mkdir(resolve(session, ".."), { recursive: true });
  await writeFile(state, '{"drafts":[{"body":"keep my review"}]}\n');
  await writeFile(session, '{"type":"message","text":"keep my session"}\n');
  const sentinels = await Promise.all([state, session].map((path) => readFile(path)));
  return {
    directory, root, origin, head, service, state, session, sentinels,
    cache: createCheckoutCache(root, runtime),
    repo: service.repoDirForRef(ref),
    worktree: service.worktreeDirForRef(ref),
    repoId: "repos/github.com/fixture/project",
    worktreeId: "worktrees/github.com/fixture/project/pr-1",
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function assertSentinels(f: Fixture): Promise<void> {
  assert.deepEqual(await Promise.all([f.state, f.session].map((path) => readFile(path))), f.sentinels);
}

async function assertRefused(f: Fixture, id: string, reason: RegExp): Promise<void> {
  const inventory = await f.cache.inventory();
  assert.deepEqual(inventory.blockers, []);
  const entry = inventory.entries.find((candidate) => candidate.id === id);
  assert.ok(entry, `missing inventory entry ${id}`);
  assert.match(entry.reasons.join("; "), reason);
  await assert.rejects(f.cache.evict(id, true), reason);
  assert.ok(existsSync(entry.path));
  assert.equal(existsSync(resolve(f.root, CACHE_LOCK)), false);
  await assertSentinels(f);
}

test("clean PR worktrees can be evicted and recreated without touching durable state or sessions", async (t) => {
  const f = await fixture(t);
  const inventory = await f.cache.inventory();
  assert.deepEqual(inventory.blockers, []);
  assert.deepEqual(inventory.entries.map(({ id, kind }) => ({ id, kind })), [
    { id: f.worktreeId, kind: "worktree" }, { id: f.repoId, kind: "repo" },
  ]);
  assert.deepEqual(inventory.entries[0].reasons, []);
  assert.equal(await cacheGit(["rev-parse", "refs/pi-pr-review/pr-1"], f.repo), f.head);
  assert.notEqual(await cacheGit(["rev-parse", "origin/main"], f.repo), f.head);
  await assertSentinels(f);

  await f.cache.evict(f.worktreeId, true);
  assert.equal(existsSync(f.worktree), false);
  assert.ok(existsSync(f.repo));
  assert.equal((await cacheGit(["worktree", "list", "--porcelain"], f.repo)).includes(`worktree ${f.worktree}`), false);
  await assertSentinels(f);

  const release = ownCheckoutCache(f.root);
  try {
    assert.equal(await f.service.preparePrWorktree(ref, f.origin, f.head), f.worktree);
    assert.equal(await f.service.preparePrWorktree(ref, f.origin, f.head), f.worktree);
    assert.equal(await cacheGit(["rev-parse", "HEAD"], f.worktree), f.head);
    assert.equal(await readFile(resolve(f.worktree, "README.md"), "utf8"), "PR content\n");
  } finally {
    release();
  }
  assert.deepEqual((await f.cache.inventory()).entries[0].reasons, []);
  await assertSentinels(f);
});

test("clean full clones can be evicted only after their linked worktrees", async (t) => {
  const f = await fixture(t);
  await assertRefused(f, f.repoId, /clone still has linked worktrees/);
  await f.cache.evict(f.worktreeId, true);
  const inventory = await f.cache.inventory();
  assert.deepEqual(inventory.entries, [{ id: f.repoId, path: f.repo, kind: "repo", reasons: [] }]);
  await f.cache.evict(f.repoId, true);
  assert.equal(existsSync(f.repo), false);
  assert.deepEqual((await f.cache.inventory()).entries, []);
  assert.equal(existsSync(resolve(f.root, CACHE_LOCK)), false);
  await assertSentinels(f);
});

for (const kind of ["worktree", "repo"] as const) {
  for (const change of ["dirty", "staged", "untracked", "ignored"] as const) {
    test(`${kind} eviction refuses ${change} files and preserves their contents`, async (t) => {
      const f = await fixture(t);
      if (kind === "repo") await f.cache.evict(f.worktreeId, true);
      const checkout = f[kind];
      const path = resolve(checkout, change === "ignored" ? "ignored.log" : change === "untracked" ? "notes.txt" : "README.md");
      await writeFile(path, `${change} user content\n`);
      if (change === "staged") await cacheGit(["add", "README.md"], checkout);
      const before = await cacheGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], checkout);
      await assertRefused(f, kind === "repo" ? f.repoId : f.worktreeId, /tracked, staged, untracked, or ignored files/);
      assert.equal(await readFile(path, "utf8"), `${change} user content\n`);
      assert.equal(await cacheGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], checkout), before);
    });
  }

  for (const reset of [false, true]) {
    test(`${kind} eviction preserves a detached local commit${reset ? " hidden by reset in its reflog" : " at HEAD"}`, async (t) => {
      const f = await fixture(t);
      if (kind === "repo") await f.cache.evict(f.worktreeId, true);
      const checkout = f[kind];
      const originalHead = await cacheGit(["rev-parse", "HEAD"], checkout);
      await cacheGit(["checkout", "--detach"], checkout);
      await writeFile(resolve(checkout, "README.md"), "local commit content\n");
      await cacheGit(["add", "README.md"], checkout);
      const localHead = await commit(checkout, "Unpublished local work");
      if (reset) {
        await cacheGit(["reset", "--hard", originalHead], checkout);
        assert.equal(await cacheGit(["rev-parse", "HEAD"], checkout), originalHead);
        assert.ok((await cacheGit(["reflog", "show", "--format=%H", "HEAD"], checkout)).split("\n").includes(localHead));
      }
      assert.equal(await cacheGit(["status", "--porcelain"], checkout), "");
      await assertRefused(f, kind === "repo" ? f.repoId : f.worktreeId, /local commits\/refs\/reflogs are not covered/);
      assert.equal(await cacheGit(["show", `${localHead}:README.md`], checkout), "local commit content");
    });
  }
}

for (const damage of ["corrupt", "missing"] as const) {
  test(`eviction fails closed with a ${damage} Git index`, async (t) => {
    const f = await fixture(t);
    const index = resolve(f.worktree, await cacheGit(["rev-parse", "--git-path", "index"], f.worktree));
    if (damage === "missing") await rm(index);
    else await writeFile(index, "not a Git index\n");
    await assertRefused(f, f.worktreeId, damage === "missing" ? /inspection failed: Missing Git index/ : /inspection failed:/);
    if (damage === "corrupt") assert.equal(await readFile(index, "utf8"), "not a Git index\n");
    else assert.equal(existsSync(index), false);
    assert.equal(await readFile(resolve(f.worktree, "README.md"), "utf8"), "PR content\n");
  });
}

test("eviction requires offline confirmation and a known inventory ID", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.cache.evict(f.worktreeId, false), /Confirm offline maintenance/);
  await assert.rejects(f.cache.evict("../origin", true), /Unknown checkout ID/);
  assert.equal(existsSync(resolve(f.root, CACHE_LOCK)), false);
  assert.ok(existsSync(f.worktree));
  assert.ok(existsSync(f.origin));
});

test("cache ownership blocks inventory eligibility and eviction without stealing the lock", async (t) => {
  const f = await fixture(t);
  const release = ownCheckoutCache(f.root);
  const ownerPath = resolve(f.root, CACHE_LOCK, "owner.json");
  try {
    const owner = await readFile(ownerPath);
    assert.match((await f.cache.inventory()).blockers.join("; "), /cache owner lock exists/);
    assert.throws(() => ownCheckoutCache(f.root), /owned or needs manual lock recovery/);
    await assert.rejects(f.cache.evict(f.worktreeId, true), /owned or needs manual lock recovery/);
    assert.deepEqual(await readFile(ownerPath), owner);
    assert.ok(existsSync(f.worktree));
  } finally {
    release();
    release();
  }
  assert.equal(existsSync(resolve(f.root, CACHE_LOCK)), false);
  await f.cache.evict(f.worktreeId, true);
});

for (const failure of [false, true]) {
  test(`eviction is blocked when process inspection ${failure ? "fails" : "finds a checkout user"}`, async (t) => {
    const f = await fixture(t);
    const cache = createCheckoutCache(f.root, {
      git: cacheGit,
      async users() {
        if (failure) throw new Error("process list unavailable");
        return ["fixture terminal has an open checkout"];
      },
    });
    const reason = failure ? /process list unavailable/ : /fixture terminal has an open checkout/;
    assert.match((await cache.inventory()).blockers.join("; "), reason);
    await assert.rejects(cache.evict(f.worktreeId, true), reason);
    assert.equal(existsSync(resolve(f.root, CACHE_LOCK)), false);
    assert.ok(existsSync(f.worktree));
    await assertSentinels(f);
  });
}

test("Git-locked worktrees are preserved", async (t) => {
  const f = await fixture(t);
  await cacheGit(["worktree", "lock", "--reason", "keep for user", f.worktree], f.repo);
  await assertRefused(f, f.worktreeId, /missing, locked, or prunable Git worktree registration/);
  assert.match(await cacheGit(["worktree", "list", "--porcelain"], f.repo), /locked keep for user/);
});

test("symlinked worktrees are not followed or removed", async (t) => {
  const f = await fixture(t);
  const target = resolve(f.directory, "moved-worktree");
  await rename(f.worktree, target);
  await symlink(target, f.worktree, "dir");
  await assertRefused(f, f.worktreeId, /Symlinked checkout paths require manual handling/);
  assert.equal(await realpath(f.worktree), target);
  assert.equal(await readFile(resolve(target, "README.md"), "utf8"), "PR content\n");
});

test("worktrees linked to the wrong clone are preserved", async (t) => {
  const f = await fixture(t);
  await f.cache.evict(f.worktreeId, true);
  await cacheGit(["worktree", "add", "--detach", f.worktree, f.head], f.origin);
  await assertRefused(f, f.worktreeId, /Git linkage points outside its expected cache clone/);
  assert.ok((await cacheGit(["worktree", "list", "--porcelain"], f.origin)).includes(`worktree ${f.worktree}`));
  assert.equal(await readFile(resolve(f.worktree, "README.md"), "utf8"), "PR content\n");
});

test("failed Git removal never falls back to recursive deletion", async (t) => {
  const f = await fixture(t);
  const cache = createCheckoutCache(f.root, {
    ...runtime,
    async git(args, cwd) {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("Git refused removal");
      return cacheGit(args, cwd);
    },
  });
  await assert.rejects(cache.evict(f.worktreeId, true), /Git refused removal/);
  assert.ok(existsSync(f.worktree));
  await assertSentinels(f);
});

test("clean commits do not justify deleting custom worktree metadata or local tag annotations", async (t) => {
  const f = await fixture(t);
  const gitDir = await cacheGit(["rev-parse", "--absolute-git-dir"], f.worktree);
  await writeFile(resolve(gitDir, "user-notes"), "keep these notes");
  await assertRefused(f, f.worktreeId, /worktree-specific Git state/);
  await rm(resolve(gitDir, "user-notes"));
  await f.cache.evict(f.worktreeId, true);
  await cacheGit([...commitOptions, "tag", "-a", "local-note", "-m", "unpublished annotation"], f.repo);
  await assertRefused(f, f.repoId, /tags\/notes\/stashes\/replace refs/);
});

test("changed PR HEAD never replaces a dirty real checkout; safe eviction permits the new revision", async (t) => {
  const f = await fixture(t);
  await writeFile(resolve(f.origin, "README.md"), "updated upstream\n");
  await cacheGit(["add", "README.md"], f.origin);
  const nextHead = await commit(f.origin, "Update PR");
  await cacheGit(["update-ref", "refs/pull/1/head", nextHead], f.origin);
  await writeFile(resolve(f.worktree, "README.md"), "local changes\n");
  await assert.rejects(f.service.preparePrWorktree(ref, f.origin, nextHead), /offline maintenance/);
  assert.equal(await readFile(resolve(f.worktree, "README.md"), "utf8"), "local changes\n");
  assert.equal(await cacheGit(["rev-parse", "HEAD"], f.worktree), f.head);
  await writeFile(resolve(f.worktree, "README.md"), "PR content\n");
  await f.cache.evict(f.worktreeId, true);
  assert.equal(await f.service.preparePrWorktree(ref, f.origin, nextHead), f.worktree);
  assert.equal(await cacheGit(["rev-parse", "HEAD"], f.worktree), nextHead);
  await assertSentinels(f);
});

test("initialized submodules require manual preservation even when Git status is clean", async (t) => {
  const f = await fixture(t);
  const submoduleOrigin = resolve(f.directory, "submodule-origin");
  await initRepository(submoduleOrigin);
  await cacheGit(["-c", "protocol.file.allow=always", "submodule", "add", submoduleOrigin, "dependency"], f.origin);
  const head = await commit(f.origin, "Add local submodule");
  await cacheGit(["update-ref", "refs/pull/1/head", head], f.origin);
  await f.cache.evict(f.worktreeId, true);
  const release = ownCheckoutCache(f.root);
  try {
    await f.service.preparePrWorktree(ref, f.origin, head);
    await cacheGit(["-c", "protocol.file.allow=always", "submodule", "update", "--init"], f.worktree);
  } finally {
    release();
  }
  assert.equal(await cacheGit(["status", "--porcelain"], f.worktree), "");
  await assertRefused(f, f.worktreeId, /populated or ambiguous submodules require manual handling/);
  assert.equal(await readFile(resolve(f.worktree, "dependency", "README.md"), "utf8"), "base content\n");
});
