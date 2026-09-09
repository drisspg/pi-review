import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { fileFingerprint } from "../../src/file-fingerprint.js";
import { createMissingPatchRecovery } from "../../src/missing-patches.js";
import { validateReviewDraftTarget } from "../../src/review-draft-tool.js";
import type { PullFile, PullRequestReviewData } from "../../src/types.js";

const exec = promisify(execFile);

/** Minimal immutable snapshot: recovery needs only revision, files, and viewed identities. */
function snapshot(files: PullFile[], baseSha = "a".repeat(40), headSha = "b".repeat(40)): PullRequestReviewData {
  return { pr: { key: "pr", baseSha, headSha }, files, fileReviews: files.map((file) => ({ prKey: "pr", path: file.filename, fingerprint: fileFingerprint(file), viewed: false, updatedAt: "now" })) } as PullRequestReviewData;
}

function file(filename: string, status = "modified"): PullFile {
  return { filename, status, additions: 1, deletions: 1, changes: 2 };
}

test("recovers large merge-base patches, additions, deletions and renamed paths from commits, not worktree edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-missing-patch-"));
  const git = async (args: string[]) => (await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15_000 })).stdout;
  try {
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.com"]);
    const large = Array.from({ length: 6200 }, (_, i) => `old_${i}`).join("\n") + "\n";
    await writeFile(join(cwd, "large.py"), large);
    await writeFile(join(cwd, "renamed old.py"), "before\n");
    await writeFile(join(cwd, "deleted.py"), "gone\n");
    await writeFile(join(cwd, "upstream.py"), "original\n");
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "base"]);
    const mergeBase = (await git(["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "upstream.py"), "upstream change\n");
    await git(["commit", "--quiet", "-am", "advance base"]);
    const baseSha = (await git(["rev-parse", "HEAD"])).trim();
    await git(["checkout", "--quiet", "--detach", mergeBase]);
    await writeFile(join(cwd, "large.py"), large.replaceAll("old_", "new_"));
    const renamedPath = "renamed ü[1]\tnew.py";
    await rename(join(cwd, "renamed old.py"), join(cwd, renamedPath));
    await writeFile(join(cwd, renamedPath), "after\n");
    await rm(join(cwd, "deleted.py"));
    await writeFile(join(cwd, "added.py"), "added\n");
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 3, 4]));
    await git(["add", "."]);
    await git(["commit", "--quiet", "-m", "PR"]);
    const headSha = (await git(["rev-parse", "HEAD"])).trim();
    await writeFile(join(cwd, "large.py"), "USER UNSAVED WORK\n");
    const data = snapshot([file("large.py"), { ...file(renamedPath, "renamed"), previous_filename: "renamed old.py" }, file("deleted.py", "removed"), file("added.py", "added"), file("binary.bin"), file("upstream.py")], baseSha, headSha);
    const warnings: string[] = [];
    const result = await createMissingPatchRecovery({ git, warn: (message) => warnings.push(message) })(data, cwd);
    const patch = result.files[0].patch!;
    assert.match(patch, /^@@ -1,6200 \+1,6200 @@/);
    assert.match(patch, /\+new_6199/);
    assert.doesNotMatch(patch, /USER UNSAVED WORK/);
    assert.match(result.files[1].patch!, /-before\n\+after/);
    assert.match(result.files[2].patch!, /-gone/);
    assert.match(result.files[3].patch!, /\+added/);
    assert.equal(result.files[4].patch, undefined);
    assert.equal(result.files[5].patch, undefined, "base-branch-only changes must not enter the PR diff");
    assert.deepEqual(warnings, []);
    assert.equal(data.files[0].patch, undefined);
    assert.notEqual(result.fileReviews[0].fingerprint, data.fileReviews[0].fingerprint);
    assert.equal(result.fileReviews[0].fingerprint, fileFingerprint(result.files[0]));
    assert.doesNotThrow(() => validateReviewDraftTarget({ headSha, files: result.files }, { path: "large.py", line: 6200, side: "RIGHT", body: "Reviewable recovered line" }));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("existing patches are untouched and do not spawn git", async () => {
  const data = snapshot([{ ...file("a.py"), patch: "@@ -1 +1 @@\n-a\n+b" }]);
  const result = await createMissingPatchRecovery({ git: async () => { throw new Error("must not run"); }, warn: () => assert.fail("must not warn") })(data, "cwd");
  assert.equal(result, data);
});

test("missing base is fetched once and per-file failures do not hide other recovered patches", async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const recover = createMissingPatchRecovery({
    async git(args) {
      calls.push(args);
      if (args[0] === "cat-file") throw new Error("missing base");
      if (args[0] === "merge-base") return "a".repeat(40);
      if (args.includes(":(literal)failed.py")) throw new Error("diff failed");
      return args[0] === "diff" ? "diff --git a/good.py b/good.py\n@@ -1 +1 @@\n-old\n+new\n" : "";
    },
    warn: (message) => warnings.push(message),
  });
  const result = await recover(snapshot([file("failed.py"), file("good.py")]), "cwd");
  assert.equal(calls.filter((args) => args[0] === "fetch").length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(result.files[0].patch, undefined);
  assert.match(result.files[1].patch!, /\+new/);
});
