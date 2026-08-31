import assert from "node:assert/strict";
import test from "node:test";

import { createGitInterdiff, parseGitDiffFiles, patchSignature, safeDiffPath, type GitInterdiffDeps } from "../../src/interdiff-git.js";
import type { PullFile, PullRequestRef } from "../../src/types.js";

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

function currentFile(filename: string, patch?: string): PullFile {
  return { filename, status: "modified", additions: 1, deletions: 0, changes: 1, ...(patch == null ? {} : { patch }) };
}

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

test("patchSignature keeps only change lines so context and offsets do not matter", () => {
  assert.equal(patchSignature("@@ -1,3 +1,4 @@\n context\n-old\n+new"), "-old\n+new");
  assert.equal(patchSignature("@@ -9,3 +12,4 @@\n moved context\n-old\n+new"), "-old\n+new");
  assert.equal(patchSignature(undefined), "");
});

test("safeDiffPath rejects traversal, flags, and absolute paths", () => {
  assert.equal(safeDiffPath("src/a.ts"), true);
  assert.equal(safeDiffPath("../etc/passwd"), false);
  assert.equal(safeDiffPath("-rf"), false);
  assert.equal(safeDiffPath("/etc/passwd"), false);
  assert.equal(safeDiffPath(42), false);
});

function fakeDeps(handlers: (args: string[]) => string | Promise<string>): GitInterdiffDeps & { gitCalls: string[][] } {
  const gitCalls: string[][] = [];
  return {
    gitCalls,
    exists: () => true,
    async git(args) {
      gitCalls.push(args);
      return handlers(args);
    },
    repoDirForRef: () => "/tmp/repos/pytorch",
  };
}

test("gitInterdiff returns the exact delta when commits were appended", async () => {
  const deps = fakeDeps((args) => {
    if (args[0] === "cat-file") return "";
    if (args.includes("--is-ancestor")) return "";
    if (args[0] === "rev-list") return "4\n";
    if (args[0] === "diff") return diffOutput;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });

  const result = await createGitInterdiff(deps)(ref, "aaa1111", "bbb2222", [currentFile("src/changed.ts")]);

  assert.equal(result.rewritten, false);
  assert.equal(result.totalCommits, 4);
  assert.equal(result.files.length, 5);
  assert.deepEqual(deps.gitCalls.find((args) => args[0] === "diff"), ["diff", "--no-color", "--find-renames", "aaa1111", "bbb2222"]);
});

test("gitInterdiff filters rewritten history to files whose own patch changed", async () => {
  const oldDiff = [
    "diff --git a/src/unchanged.ts b/src/unchanged.ts",
    "--- a/src/unchanged.ts",
    "+++ b/src/unchanged.ts",
    "@@ -1,2 +1,2 @@",
    " old context",
    "-before",
    "+after",
    "diff --git a/src/edited.ts b/src/edited.ts",
    "--- a/src/edited.ts",
    "+++ b/src/edited.ts",
    "@@ -5,1 +5,1 @@",
    "+first version",
    "",
  ].join("\n");
  const deps = fakeDeps((args) => {
    if (args[0] === "cat-file") return "";
    if (args.includes("--is-ancestor")) throw new Error("not an ancestor");
    if (args[0] === "merge-base") return "fork0000\n";
    if (args[0] === "diff") return oldDiff;
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });
  const currentFiles = [
    // Same change lines, different hunk offsets/context after the rebase: excluded.
    currentFile("src/unchanged.ts", "@@ -7,2 +7,2 @@\n new context\n-before\n+after"),
    // The change itself evolved: included.
    currentFile("src/edited.ts", "@@ -5,1 +5,1 @@\n+second version"),
    // New file since the last review: included.
    currentFile("src/brand-new.ts", "@@ -0,0 +1,1 @@\n+hello"),
  ];

  const result = await createGitInterdiff(deps)(ref, "aaa1111", "bbb2222", currentFiles);

  assert.equal(result.rewritten, true);
  assert.equal(result.totalCommits, 0);
  assert.deepEqual(result.files.map((file) => file.filename), ["src/edited.ts", "src/brand-new.ts"]);
  assert.deepEqual(deps.gitCalls.find((args) => args[0] === "diff"), ["diff", "--no-color", "--find-renames", "fork0000", "aaa1111"]);
});

test("gitInterdiff falls back to all current files when no fork point exists", async () => {
  const deps = fakeDeps((args) => {
    if (args[0] === "cat-file") return "";
    if (args.includes("--is-ancestor")) throw new Error("not an ancestor");
    if (args[0] === "merge-base") throw new Error("no merge base");
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });
  const currentFiles = [currentFile("a.ts", "+x")];

  const result = await createGitInterdiff(deps)(ref, "aaa1111", "bbb2222", currentFiles);

  assert.equal(result.rewritten, true);
  assert.deepEqual(result.files, currentFiles);
});

test("gitInterdiff tries an upstream fetch before declaring the old head lost", async () => {
  let catFileCalls = 0;
  const deps = fakeDeps((args) => {
    if (args[0] === "cat-file") {
      catFileCalls += 1;
      throw new Error("fatal: not a valid object");
    }
    if (args[0] === "fetch") return "";
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  });

  await assert.rejects(createGitInterdiff(deps)(ref, "aaa1111", "bbb2222", []), /no longer available locally or upstream/);
  assert.equal(catFileCalls, 2);
  assert.ok(deps.gitCalls.some((args) => args[0] === "fetch" && args.includes("aaa1111")));
  await assert.rejects(createGitInterdiff({ ...deps, exists: () => false })(ref, "aaa1111", "bbb2222", []), /No cached repository/);
});
