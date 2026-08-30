import assert from "node:assert/strict";
import test from "node:test";

import { createReviewArchiveApi } from "../../src/review-archive-api.js";
import type { PullRequestRef, PullRequestReviewData, ReviewMemoryRecord } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };
const reviewData: PullRequestReviewData = {
  pr: { key: "github.com/pytorch/pytorch#1", ref, url: "https://github.com/pytorch/pytorch/pull/1", title: "PR", body: null, state: "open", author: "alice", baseSha: "base", headSha: "head", filesChanged: 1, existingCommentCount: 0, lastOpenedAt: "now", lastReviewedHeadSha: null, lastReviewEvent: null, reviewDecision: null },
  raw: { number: 1, title: "PR", html_url: "https://github.com/pytorch/pytorch/pull/1", state: "open", body: null, user: { login: "alice" }, base: { ref: "main", sha: "base", repo: { full_name: "pytorch/pytorch", clone_url: "git", html_url: "repo" } }, head: { ref: "branch", sha: "head", repo: null } },
  files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@" }],
  comments: [],
  issueComments: [],
  reviewSummaries: [],
  fileReviews: [],
};

test("review archive saves a local snapshot and clears the active draft", async () => {
  const calls: string[] = [];
  const api = createReviewArchiveApi({
    async clearDraftReview(prKey) {
      calls.push(`clear:${prKey}`);
    },
    async fetchPullRequestReviewData(requestRef) {
      calls.push(`fetch:${requestRef.number}`);
      return reviewData;
    },
    async markPullRequestReviewed(prKey, headSha, event) {
      calls.push(`reviewed:${prKey}:${headSha}:${event}`);
      return null;
    },
    refFromBody() {
      calls.push("ref");
      return ref;
    },
    async saveReviewMemory(record) {
      calls.push(`save:${record.disposition}:${record.comments.length}`);
      return { ...record, id: "archive", createdAt: "now" } as ReviewMemoryRecord;
    },
  });

  const response = await api.archive({ prUrl: reviewData.pr.url, headSha: "head", event: "COMMENT", body: "local", comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "note" }] });

  assert.equal(response.memory.disposition, "archived");
  assert.equal(response.memory.body, "local");
  assert.deepEqual(response.memory.changeSet?.files.map((file) => file.path), ["a.ts"]);
  assert.deepEqual(calls, ["ref", "fetch:1", "save:archived:1", "reviewed:github.com/pytorch/pytorch#1:head:COMMENT", "clear:github.com/pytorch/pytorch#1"]);
});

test("review archive validates the review event before clearing drafts", async () => {
  let cleared = false;
  const api = createReviewArchiveApi({
    async clearDraftReview() {
      cleared = true;
    },
    async fetchPullRequestReviewData() {
      return reviewData;
    },
    async markPullRequestReviewed() {
      return null;
    },
    refFromBody() {
      return ref;
    },
    async saveReviewMemory(record) {
      return { ...record, id: "archive", createdAt: "now" } as ReviewMemoryRecord;
    },
  });

  await assert.rejects(api.archive({ prUrl: reviewData.pr.url, event: "BAD", comments: [] }), /Expected review event/);
  assert.equal(cleared, false);
});
