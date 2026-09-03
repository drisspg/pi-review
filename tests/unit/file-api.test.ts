import assert from "node:assert/strict";
import test from "node:test";

import { createFileApi } from "../../src/file-api.js";
import type { FileReviewState, PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };

function fakeDeps() {
  const openedUrls: string[] = [];
  const viewedReviews: FileReviewState[] = [];
  const textRequests: Array<{ ref: PullRequestRef; path: string; sha: string }> = [];
  return {
    openedUrls,
    viewedReviews,
    textRequests,
    deps: {
      async fetchFileText(requestRef: PullRequestRef, path: string, sha: string) {
        textRequests.push({ ref: requestRef, path, sha });
        return "file text";
      },
      localText: null as string | null,
      async readLocalFileText(_ref: PullRequestRef, _path: string, _sha: string) {
        return this.localText;
      },
      now() {
        return "2026-06-04T00:00:00.000Z";
      },
      async openUrl(url: string) {
        openedUrls.push(url);
      },
      parsePullRequestRef(input: string) {
        assert.equal(input, "https://github.com/pytorch/pytorch/pull/1");
        return ref;
      },
      async setFileViewed(review: FileReviewState) {
        viewedReviews.push(review);
        return review;
      },
      worktreeDirForRef(requestRef: PullRequestRef) {
        assert.deepEqual(requestRef, ref);
        return "/tmp/worktrees/pytorch/pr-1";
      },
    },
  };
}

test("file API viewed validates payload and stamps updatedAt", async () => {
  const { deps, viewedReviews } = fakeDeps();

  assert.deepEqual(await createFileApi(deps).viewed({ prKey: "pr", path: "a.ts", fingerprint: "fp", viewed: true }), {
    fileReview: { prKey: "pr", path: "a.ts", fingerprint: "fp", viewed: true, updatedAt: "2026-06-04T00:00:00.000Z" },
  });
  assert.deepEqual(viewedReviews, [{ prKey: "pr", path: "a.ts", fingerprint: "fp", viewed: true, updatedAt: "2026-06-04T00:00:00.000Z" }]);
});

test("file API text validates payload and delegates to GitHub file fetch", async () => {
  const { deps, textRequests } = fakeDeps();

  assert.deepEqual(await createFileApi(deps).text({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "torch/a.py", sha: "head" }), { text: "file text" });
  assert.deepEqual(textRequests, [{ ref, path: "torch/a.py", sha: "head" }]);
});

test("file API open resolves a safe worktree editor target", async () => {
  const { deps, openedUrls } = fakeDeps();

  assert.deepEqual(await createFileApi(deps).open({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "torch/a.py", line: 7 }), {
    target: "/tmp/worktrees/pytorch/pr-1/torch/a.py:7:1",
  });
  assert.deepEqual(openedUrls, ["vscode://file/tmp/worktrees/pytorch/pr-1/torch/a.py:7:1"]);
});

test("file API open escapes URL delimiter characters in valid file paths", async () => {
  const { deps, openedUrls } = fakeDeps();

  assert.deepEqual(await createFileApi(deps).open({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "torch/a#b?.py", line: 7 }), {
    target: "/tmp/worktrees/pytorch/pr-1/torch/a#b?.py:7:1",
  });
  assert.deepEqual(openedUrls, ["vscode://file/tmp/worktrees/pytorch/pr-1/torch/a%23b%3F.py:7:1"]);
});

test("file API open rejects paths escaping the PR worktree", async () => {
  const { deps, openedUrls } = fakeDeps();

  await assert.rejects(createFileApi(deps).open({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "../other.ts" }), /escapes PR worktree/);
  assert.deepEqual(openedUrls, []);
});

test("file API prefers the local clone for file text and falls back to GitHub", async () => {
  const fake = fakeDeps();
  fake.deps.localText = "local text";
  const api = createFileApi(fake.deps);
  assert.deepEqual(await api.text({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "a.py", sha: "abc" }), { text: "local text" });
  assert.equal(fake.textRequests.length, 0, "no GitHub fetch when the clone has the object");

  fake.deps.localText = null;
  assert.deepEqual(await api.text({ prUrl: "https://github.com/pytorch/pytorch/pull/1", path: "a.py", sha: "abc" }), { text: "file text" });
  assert.equal(fake.textRequests.length, 1);
});
