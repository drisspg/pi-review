import assert from "node:assert/strict";
import test from "node:test";

import { createBlameApi, parseBlamePorcelain, type BlameApiDeps } from "../../src/blame-api.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };
const sha = "4d0c4a84d0c4a84d0c4a84d0c4a84d0c4a84d0c4";

const porcelain = [
  `${sha} 12 12 1`,
  "author Jane Doe",
  "author-mail <jane@example.com>",
  "author-time 1735689600",
  "author-tz -0800",
  "committer Jane Doe",
  "summary Fix attention mask handling (#1234)",
  "filename src/a.ts",
  "\tconst x = 1;",
  "",
].join("\n");

function fakeDeps(overrides: Partial<BlameApiDeps> = {}): BlameApiDeps & { gitCalls: Array<{ args: string[]; cwd: string }> } {
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  return {
    gitCalls,
    exists: () => true,
    async git(args, cwd) {
      gitCalls.push({ args, cwd });
      return porcelain;
    },
    parsePullRequestRef: () => ref,
    worktreeDirForRef: () => "/tmp/worktrees/pr-1",
    ...overrides,
  };
}

test("parseBlamePorcelain extracts commit facts and the PR number", () => {
  assert.deepEqual(parseBlamePorcelain(porcelain), {
    sha,
    author: "Jane Doe",
    authorTime: "2025-01-01T00:00:00.000Z",
    summary: "Fix attention mask handling (#1234)",
    prNumber: 1234,
  });
});

test("parseBlamePorcelain returns null for uncommitted or malformed output", () => {
  assert.equal(parseBlamePorcelain(""), null);
  assert.equal(parseBlamePorcelain(`${"0".repeat(40)} 1 1 1\nauthor Not Committed Yet`), null);
});

test("blame runs git blame in the PR worktree and builds the commit URL", async () => {
  const deps = fakeDeps();

  const { blame } = await createBlameApi(deps).blame({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "src/a.ts", line: 12 });

  assert.deepEqual(deps.gitCalls, [{ args: ["blame", "--porcelain", "-L", "12,12", "HEAD", "--", "src/a.ts"], cwd: "/tmp/worktrees/pr-1" }]);
  assert.equal(blame.sha, sha);
  assert.equal(blame.prNumber, 1234);
  assert.equal(blame.commitUrl, `https://github.com/pytorch/pytorch/commit/${sha}`);
});

test("blame rejects malformed payloads and missing worktrees", async () => {
  const blameApi = createBlameApi(fakeDeps());
  await assert.rejects(blameApi.blame({ path: "a.ts", line: 1 }), /prUrl/);
  await assert.rejects(blameApi.blame({ prUrl: "url", path: "../etc/passwd", line: 1 }), /repository-relative/);
  await assert.rejects(blameApi.blame({ prUrl: "url", path: "-flag", line: 1 }), /repository-relative/);
  await assert.rejects(blameApi.blame({ prUrl: "url", path: "a.ts", line: 0 }), /line number/);
  await assert.rejects(createBlameApi(fakeDeps({ exists: () => false })).blame({ prUrl: "url", path: "a.ts", line: 1 }), /worktree/);
});
