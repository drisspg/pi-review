import assert from "node:assert/strict";
import test from "node:test";

import { createWorktreeService } from "../../src/worktrees.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "PyTorch", repo: "PyTorch", number: 185924 };

type GitCall = { args: string[]; cwd?: string };

function fakeRuntime(existingPaths = new Set<string>(), heads = new Map<string, string>()) {
  const gitCalls: GitCall[] = [];
  const mkdirCalls: string[] = [];
  const rmCalls: string[] = [];
  return {
    gitCalls,
    mkdirCalls,
    rmCalls,
    runtime: {
      exists(path: string) {
        return existingPaths.has(path);
      },
      async git(args: string[], cwd?: string) {
        gitCalls.push({ args, cwd });
        if (args[0] === "rev-parse") return heads.get(cwd ?? "") ?? "old-sha";
        return "";
      },
      async mkdir(path: string) {
        mkdirCalls.push(path);
      },
      async rm(path: string) {
        rmCalls.push(path);
      },
    },
  };
}

test("worktree service builds safe repo and worktree paths", () => {
  const service = createWorktreeService(fakeRuntime().runtime, "/tmp/pi-review-test");

  assert.equal(service.repoDirForRef(ref), "/tmp/pi-review-test/repos/github.com/pytorch/pytorch");
  assert.equal(service.worktreeDirForRef(ref), "/tmp/pi-review-test/worktrees/github.com/pytorch/pytorch/pr-185924");
});

test("prepare clones missing repo and creates requested detached worktree", async () => {
  const { runtime, gitCalls, mkdirCalls, rmCalls } = fakeRuntime();
  const service = createWorktreeService(runtime, "/tmp/pi-review-test");

  const worktreeDir = await service.preparePrWorktree(ref, "git@github.com:pytorch/pytorch.git", "new-sha");

  assert.equal(worktreeDir, "/tmp/pi-review-test/worktrees/github.com/pytorch/pytorch/pr-185924");
  assert.deepEqual(mkdirCalls, ["/tmp/pi-review-test/repos/github.com/pytorch", "/tmp/pi-review-test/worktrees/github.com/pytorch/pytorch"]);
  assert.deepEqual(rmCalls, [worktreeDir]);
  assert.deepEqual(gitCalls, [
    { args: ["clone", "git@github.com:pytorch/pytorch.git", "/tmp/pi-review-test/repos/github.com/pytorch/pytorch"], cwd: undefined },
    { args: ["worktree", "remove", "--force", worktreeDir], cwd: "/tmp/pi-review-test/repos/github.com/pytorch/pytorch" },
    { args: ["worktree", "prune"], cwd: "/tmp/pi-review-test/repos/github.com/pytorch/pytorch" },
    { args: ["fetch", "--force", "origin", "pull/185924/head:refs/pi-pr-review/pr-185924"], cwd: "/tmp/pi-review-test/repos/github.com/pytorch/pytorch" },
    { args: ["worktree", "add", "--detach", "--force", worktreeDir, "new-sha"], cwd: "/tmp/pi-review-test/repos/github.com/pytorch/pytorch" },
  ]);
});

test("prepare skips when existing worktree is already at head", async () => {
  const worktreeDir = "/tmp/pi-review-test/worktrees/github.com/pytorch/pytorch/pr-185924";
  const { runtime, gitCalls, rmCalls } = fakeRuntime(new Set(["/tmp/pi-review-test/repos/github.com/pytorch/pytorch/.git", worktreeDir]), new Map([[worktreeDir, "new-sha"]]));
  const service = createWorktreeService(runtime, "/tmp/pi-review-test");

  assert.equal(await service.preparePrWorktree(ref, "git@github.com:pytorch/pytorch.git", "new-sha"), worktreeDir);
  assert.deepEqual(gitCalls, [{ args: ["rev-parse", "HEAD"], cwd: worktreeDir }]);
  assert.deepEqual(rmCalls, []);
});

test("cleanup removes git worktree when repo exists and always removes directory", async () => {
  const repoGitDir = "/tmp/pi-review-test/repos/github.com/pytorch/pytorch/.git";
  const worktreeDir = "/tmp/pi-review-test/worktrees/github.com/pytorch/pytorch/pr-185924";
  const { runtime, gitCalls, rmCalls } = fakeRuntime(new Set([repoGitDir]));
  const service = createWorktreeService(runtime, "/tmp/pi-review-test");

  assert.equal(await service.cleanupPrWorktree(ref), worktreeDir);
  assert.deepEqual(gitCalls, [
    { args: ["worktree", "remove", "--force", worktreeDir], cwd: "/tmp/pi-review-test/repos/github.com/pytorch/pytorch" },
    { args: ["worktree", "prune"], cwd: "/tmp/pi-review-test/repos/github.com/pytorch/pytorch" },
  ]);
  assert.deepEqual(rmCalls, [worktreeDir]);
});

test("cleanup skips git commands when repo is missing and still removes worktree directory", async () => {
  const worktreeDir = "/tmp/pi-review-test/worktrees/github.com/pytorch/pytorch/pr-185924";
  const { runtime, gitCalls, rmCalls } = fakeRuntime();
  const service = createWorktreeService(runtime, "/tmp/pi-review-test");

  assert.equal(await service.cleanupPrWorktree(ref), worktreeDir);
  assert.deepEqual(gitCalls, []);
  assert.deepEqual(rmCalls, [worktreeDir]);
});
