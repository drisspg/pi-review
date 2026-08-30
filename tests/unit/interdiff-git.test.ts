import assert from "node:assert/strict";
import test from "node:test";

import { createGitInterdiff, parseGitDiffFiles, safeDiffPath, type GitInterdiffDeps } from "../../src/interdiff-git.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };

const diffOutput = [
  "diff --git a/src/changed.ts b/src/changed.ts",
  "index 1111111..2222222 100644",
  "--- a/src/changed.ts",
  "+++ b/src/changed.ts",
  "@@ -1,3 +1,4 @@",
  " context",
  "-old line",
  "+new line",
  "+another line",
  "diff --git a/src/created.ts b/src/created.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/created.ts",
  "@@ -0,0 +1,2 @@",
  "+alpha",
  "+beta",
  "diff --git a/src/dropped.ts b/src/dropped.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/src/dropped.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-gone",
  "diff --git a/src/old-name.ts b/src/new-name.ts",
  "similarity index 90%",
  "rename from src/old-name.ts",
  "rename to src/new-name.ts",
  "index 5555555..6666666 100644",
  "--- a/src/old-name.ts",
  "+++ b/src/new-name.ts",
  "@@ -2,1 +2,1 @@",
  "-before",
  "+after",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 7777777..8888888 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "",
].join("\n");

test("parseGitDiffFiles maps git diff output to the GitHub files shape", () => {
  const files = parseGitDiffFiles(diffOutput);

  assert.deepEqual(files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, previous: file.previous_filename ?? null, hasPatch: file.patch != null })), [
    { filename: "src/changed.ts", status: "modified", additions: 2, deletions: 1, previous: null, hasPatch: true },
    { filename: "src/created.ts", status: "added", additions: 2, deletions: 0, previous: null, hasPatch: true },
    { filename: "src/dropped.ts", status: "removed", additions: 0, deletions: 1, previous: null, hasPatch: true },
    { filename: "src/new-name.ts", status: "renamed", additions: 1, deletions: 1, previous: "src/old-name.ts", hasPatch: true },
    { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0, previous: null, hasPatch: false },
  ]);
  assert.equal(files[0].patch, "@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+another line");
  assert.deepEqual(parseGitDiffFiles(""), []);
});

test("safeDiffPath rejects traversal, flags, and absolute paths", () => {
  assert.equal(safeDiffPath("src/a.ts"), true);
  assert.equal(safeDiffPath("../etc/passwd"), false);
  assert.equal(safeDiffPath("-rf"), false);
  assert.equal(safeDiffPath("/etc/passwd"), false);
  assert.equal(safeDiffPath(42), false);
});

test("gitInterdiff verifies the old commit and scopes the diff to the given paths", async () => {
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  const deps: GitInterdiffDeps = {
    exists: () => true,
    async git(args, cwd) {
      gitCalls.push({ args, cwd });
      if (args[0] === "cat-file") return "";
      if (args[0] === "rev-list") return "4\n";
      return diffOutput;
    },
    repoDirForRef: () => "/tmp/repos/pytorch",
  };

  const result = await createGitInterdiff(deps)(ref, "aaa1111", "bbb2222", ["src/changed.ts", "src/created.ts"]);

  assert.equal(result.totalCommits, 4);
  assert.equal(result.files.length, 5);
  assert.deepEqual(gitCalls[0], { args: ["cat-file", "-e", "aaa1111^{commit}"], cwd: "/tmp/repos/pytorch" });
  assert.deepEqual(gitCalls.find((call) => call.args[0] === "diff")?.args, ["diff", "--no-color", "--find-renames", "aaa1111", "bbb2222", "--", "src/changed.ts", "src/created.ts"]);
});

test("gitInterdiff reports a missing local commit clearly", async () => {
  const deps: GitInterdiffDeps = {
    exists: () => true,
    async git(args) {
      if (args[0] === "cat-file") throw new Error("fatal: not a valid object");
      return "";
    },
    repoDirForRef: () => "/tmp/repos/pytorch",
  };

  await assert.rejects(createGitInterdiff(deps)(ref, "aaa1111", "bbb2222", []), /no longer available locally/);
  await assert.rejects(createGitInterdiff({ ...deps, exists: () => false })(ref, "aaa1111", "bbb2222", []), /No cached repository/);
});
