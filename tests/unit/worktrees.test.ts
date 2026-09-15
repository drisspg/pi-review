import assert from "node:assert/strict";
import test from "node:test";

import { createWorktreeService } from "../../src/worktrees.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "PyTorch", repo: "PyTorch", number: 185924 };
const root = "/tmp/pi-review-test";
const repo = `${root}/repos/github.com/pytorch/pytorch`;
const worktree = `${root}/worktrees/github.com/pytorch/pytorch/pr-185924`;

function fixture() {
  const paths = new Set<string>();
  const calls: string[][] = [];
  const runtime = {
    exists: (path: string) => paths.has(path),
    async git(args: string[], _cwd?: string) {
      calls.push(args);
      if (args[0] === "clone") { paths.add(repo); paths.add(`${repo}/.git`); }
      if (args[0] === "rev-parse") return args[1] === "HEAD" ? "head" : `${worktree}/index`;
      if (args[0] === "worktree" && args[1] === "add") { paths.add(args[3]); paths.add(`${args[3]}/index`); }
      return "";
    },
    async mkdir() {},
  };
  return { paths, calls, runtime, service: createWorktreeService(runtime, root) };
}

test("worktree paths are cache-root scoped and sanitized", () => {
  const { service } = fixture();
  assert.equal(service.repoDirForRef(ref), repo);
  assert.equal(service.worktreeDirForRef(ref), worktree);
});

test("prepare clones once, creates detached worktree without force, and reuses it", async () => {
  const { service, calls } = fixture();
  assert.equal(await service.preparePrWorktree(ref, "origin", "head"), worktree);
  assert.equal(await service.preparePrWorktree(ref, "origin", "head"), worktree);
  assert.deepEqual(calls, [
    ["clone", "origin", repo],
    ["fetch", "--force", "origin", "pull/185924/head:refs/pi-pr-review/pr-185924"],
    ["worktree", "add", "--detach", worktree, "head"],
    ["rev-parse", "HEAD"], ["rev-parse", "--git-path", "index"],
  ]);
});

for (const problem of ["changed HEAD", "missing index", "failed git"] as const) {
  test(`prepare preserves existing checkout on ${problem}`, async () => {
    const { paths, runtime, calls, service } = fixture();
    paths.add(worktree);
    if (problem !== "missing index") paths.add(`${worktree}/index`);
    if (problem === "failed git") runtime.git = async () => { throw new Error("git failed"); };
    await assert.rejects(service.preparePrWorktree(ref, "origin", problem === "changed HEAD" ? "new" : "head"));
    assert.ok(paths.has(worktree));
    assert.ok(calls.every((args) => args[0] === "rev-parse"));
  });
}

test("cleanup requires offline eviction and never deletes an existing checkout", async () => {
  const { paths, service, calls } = fixture();
  paths.add(worktree);
  await assert.rejects(service.cleanupPrWorktree(ref), /offline maintenance/);
  assert.ok(paths.has(worktree));
  paths.delete(worktree);
  assert.equal(await service.cleanupPrWorktree(ref), worktree);
  assert.deepEqual(calls, []);
});

test("different PR preparations share a clone lock; cleanup waits for preparation", async () => {
  const { service, runtime, paths } = fixture();
  const original = runtime.git;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let clones = 0;
  runtime.git = async (args, cwd) => {
    if (args[0] === "clone") { clones++; await gate; }
    return original(args, cwd);
  };
  const first = service.preparePrWorktree(ref, "origin", "head");
  const second = service.preparePrWorktree({ ...ref, number: 2 }, "origin", "head");
  const cleanup = assert.rejects(service.cleanupPrWorktree(ref), /offline maintenance/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clones, 1);
  assert.equal(paths.has(worktree), false);
  release();
  await Promise.all([first, second, cleanup]);
  assert.equal(clones, 1);
  assert.ok(paths.has(worktree));
});
