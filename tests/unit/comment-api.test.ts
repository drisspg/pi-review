import assert from "node:assert/strict";
import test from "node:test";

import { createCommentApi } from "../../src/comment-api.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };

function fakeDeps() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async addIssueComment(requestRef: PullRequestRef, body: string) {
        calls.push(`addIssue:${requestRef.number}:${body}`);
        return { ok: "addIssue" };
      },
      async editIssueComment(requestRef: PullRequestRef, commentId: number, body: string) {
        calls.push(`editIssue:${requestRef.number}:${commentId}:${body}`);
        return { ok: "editIssue" };
      },
      async editReviewComment(requestRef: PullRequestRef, commentId: number, body: string) {
        calls.push(`editReview:${requestRef.number}:${commentId}:${body}`);
        return { ok: "editReview" };
      },
      async editReviewSummary(requestRef: PullRequestRef, reviewId: number, body: string) {
        calls.push(`editSummary:${requestRef.number}:${reviewId}:${body}`);
        return { ok: "editSummary" };
      },
      refFromBody(payload: unknown) {
        assert.equal(typeof payload, "object");
        calls.push("ref");
        return ref;
      },
      async replyToReviewComment(requestRef: PullRequestRef, commentId: number, body: string) {
        calls.push(`replyReview:${requestRef.number}:${commentId}:${body}`);
        return { ok: "replyReview" };
      },
    },
  };
}

test("comment API reply adds issue comments without requiring commentId", async () => {
  const { deps, calls } = fakeDeps();

  assert.deepEqual(await createCommentApi(deps).reply({ kind: "issue", body: "  hello  " }), { result: { ok: "addIssue" } });
  assert.deepEqual(calls, ["ref", "addIssue:1:hello"]);
});

test("comment API reply replies to review comments when kind is not issue", async () => {
  const { deps, calls } = fakeDeps();

  assert.deepEqual(await createCommentApi(deps).reply({ kind: "review", commentId: 5, body: "  reply  " }), { result: { ok: "replyReview" } });
  assert.deepEqual(calls, ["ref", "replyReview:1:5:reply"]);
});

test("comment API edit dispatches by comment kind", async () => {
  const { deps, calls } = fakeDeps();
  const api = createCommentApi(deps);

  assert.deepEqual(await api.edit({ kind: "issue", commentId: 1, body: " issue " }), { result: { ok: "editIssue" } });
  assert.deepEqual(await api.edit({ kind: "review-summary", commentId: 2, body: " summary " }), { result: { ok: "editSummary" } });
  assert.deepEqual(await api.edit({ kind: "review", commentId: 3, body: " review " }), { result: { ok: "editReview" } });
  assert.deepEqual(calls, ["ref", "editIssue:1:1:issue", "ref", "editSummary:1:2:summary", "ref", "editReview:1:3:review"]);
});

test("comment API validates body, comment id, and edit kind", async () => {
  const api = createCommentApi(fakeDeps().deps);

  await assert.rejects(api.reply({ kind: "review", body: "body" }), /Expected commentId/);
  await assert.rejects(api.reply({ kind: "issue", body: "   " }), /Expected non-empty body/);
  await assert.rejects(api.edit({ kind: "other", commentId: 1, body: "body" }), /Expected comment kind/);
});
