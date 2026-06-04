import assert from "node:assert/strict";
import test from "node:test";

import { githubReviewComments, reviewMemoryChangeSet, reviewMemoryComments, reviewSubmitCommentsFromPayload, reviewSubmitDiagnostics, reviewSubmitFailureMessage } from "../../src/review-submit-api.js";
import type { PullRequestReviewData } from "../../src/types.js";

const reviewData = {
  raw: {
    number: 185924,
    title: "Add faster kernel",
    html_url: "https://github.com/pytorch/pytorch/pull/185924",
    base: { repo: { full_name: "pytorch/pytorch" } },
  },
  files: [
    { filename: "torch/a.py", status: "modified", additions: 4, deletions: 1, changes: 5, patch: "@@" },
    { filename: "torch/b.py", status: "added", additions: 9, deletions: 0, changes: 9, patch: "+x" },
  ],
} as PullRequestReviewData;

test("review submit payload keeps only object comments", () => {
  assert.deepEqual(reviewSubmitCommentsFromPayload([null, "bad", { path: "torch/a.py" }]), [{ path: "torch/a.py" }]);
  assert.deepEqual(reviewSubmitCommentsFromPayload({ path: "torch/a.py" }), []);
});

test("github review comments include ranges only when start differs", () => {
  assert.deepEqual(githubReviewComments([
    { path: "torch/a.py", line: 12, start_line: 10, side: "RIGHT", start_side: "RIGHT", body: "range" },
    { path: "torch/b.py", line: 7, start_line: 7, side: "RIGHT", start_side: "RIGHT", body: "single" },
  ]), [
    { path: "torch/a.py", line: 12, side: "RIGHT", body: "range", start_line: 10, start_side: "RIGHT" },
    { path: "torch/b.py", line: 7, side: "RIGHT", body: "single" },
  ]);
});

test("review memory comments trim bodies and drop invalid sides", () => {
  assert.deepEqual(reviewMemoryComments([
    { path: "torch/a.py", line: 12, start_line: 10, side: "RIGHT", body: "  useful note  " },
    { path: "torch/b.py", line: 1, side: "BAD", body: "ignored" },
    { path: "torch/c.py", line: 1, side: "LEFT", body: "   " },
  ]), [{ path: "torch/a.py", line: 12, startLine: 10, side: "RIGHT", body: "useful note" }]);
});

test("review memory change set narrows files to commented paths", () => {
  assert.deepEqual(reviewMemoryChangeSet(reviewData, [{ path: "torch/b.py", line: 7, side: "RIGHT", body: "note" }]), {
    title: "Add faster kernel",
    url: "https://github.com/pytorch/pytorch/pull/185924",
    source: "pytorch/pytorch#185924",
    files: [{ path: "torch/b.py", status: "added", additions: 9, deletions: 0, patch: "+x" }],
  });
});

test("review memory change set includes all files when no inline memory comments exist", () => {
  assert.deepEqual(reviewMemoryChangeSet(reviewData, []).files.map((file) => file.path), ["torch/a.py", "torch/b.py"]);
});

test("review submit diagnostics identify stale draft details", () => {
  assert.equal(reviewSubmitDiagnostics([{ draft_id: "d1", path: "torch/a.py", start_line: 10, line: 12, side: "RIGHT", body: "line one\nline two" }]), "Inline comments in the failed review payload:\n1. draft=d1 torch/a.py:10-12 RIGHT — line one line two");
});

test("review submit failure message appends actionable diagnostics", () => {
  const message = reviewSubmitFailureMessage(new Error("HTTP 422"), []);
  assert.match(message, /HTTP 422/);
  assert.match(message, /No inline comments were included/);
  assert.match(message, /delete or recreate/);
});
