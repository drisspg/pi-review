import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubDraftReviewApi } from "../../src/github-draft-review-api.js";
import type { GitHubPendingReview, PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };
const review: GitHubPendingReview = { id: "review-id", body: "", comments: [], updatedAt: "now" };

function fakeDeps(initialReview: GitHubPendingReview | null) {
  const calls: unknown[] = [];
  let currentReview = initialReview;
  return {
    calls,
    deps: {
      async addPendingPullRequestReviewThread(requestRef: PullRequestRef, reviewId: string, comment: unknown) {
        calls.push(["add", requestRef, reviewId, comment]);
        currentReview = review;
      },
      async createPendingPullRequestReview(requestRef: PullRequestRef, pullRequestId: string) {
        calls.push(["create", requestRef, pullRequestId]);
        currentReview = review;
        return review.id;
      },
      async fetchPendingPullRequestReview(requestRef: PullRequestRef) {
        calls.push(["fetch", requestRef]);
        return { pullRequestId: "pr-id", review: currentReview };
      },
      refFromBody(payload: unknown) {
        assert.equal(typeof payload, "object");
        return ref;
      },
    },
  };
}

test("GitHub draft review API pulls the current private review", async () => {
  const { deps, calls } = fakeDeps(review);

  assert.deepEqual(await createGitHubDraftReviewApi(deps).pull({ prUrl: "url" }), { review });
  assert.deepEqual(calls, [["fetch", ref]]);
});

test("GitHub draft review API creates a pending review before the first comment", async () => {
  const { deps, calls } = fakeDeps(null);

  assert.deepEqual(await createGitHubDraftReviewApi(deps).addComment({ prUrl: "url", path: "src/a.ts", line: 12, startLine: 10, side: "RIGHT", body: "  private note  " }), { review });
  assert.deepEqual(calls, [
    ["fetch", ref],
    ["create", ref, "pr-id"],
    ["add", ref, "review-id", { path: "src/a.ts", line: 12, startLine: 10, side: "RIGHT", body: "private note" }],
    ["fetch", ref],
  ]);
});

test("GitHub draft review API appends to an existing pending review", async () => {
  const { deps, calls } = fakeDeps(review);

  await createGitHubDraftReviewApi(deps).addComment({ prUrl: "url", path: "src/a.ts", line: null, side: "RIGHT", body: "file note" });

  assert.deepEqual(calls, [
    ["fetch", ref],
    ["add", ref, "review-id", { path: "src/a.ts", line: null, startLine: undefined, side: "RIGHT", body: "file note" }],
    ["fetch", ref],
  ]);
});

test("GitHub draft review API validates private comment targets", async () => {
  const api = createGitHubDraftReviewApi(fakeDeps(null).deps);

  await assert.rejects(api.addComment({ prUrl: "url", path: "", line: 1, side: "RIGHT", body: "note" }), /Expected comment path/);
  await assert.rejects(api.addComment({ prUrl: "url", path: "a", line: 1, side: "BAD", body: "note" }), /Expected comment side/);
  await assert.rejects(api.addComment({ prUrl: "url", path: "a", line: null, startLine: 1, body: "note" }), /File comments cannot have startLine/);
  await assert.rejects(api.addComment({ prUrl: "url", path: "a", line: 1, side: "RIGHT", body: "  " }), /Expected non-empty comment body/);
});
