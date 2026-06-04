import assert from "node:assert/strict";
import test from "node:test";

import { createReviewSubmitRouteApi } from "../../src/review-submit-route-api.js";
import type { PullRequestRef, PullRequestReviewData, ReviewMemoryRecord, StoredPullRequest } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };

function storedPr(overrides: Partial<StoredPullRequest> = {}): StoredPullRequest {
  return {
    key: "github.com/pytorch/pytorch#1",
    ref,
    url: "https://github.com/pytorch/pytorch/pull/1",
    title: "PR",
    body: null,
    state: "open",
    author: "alice",
    baseSha: "base",
    headSha: "head",
    filesChanged: 1,
    existingCommentCount: 0,
    lastOpenedAt: "2026-06-04T00:00:00.000Z",
    lastReviewedHeadSha: null,
    lastReviewEvent: null,
    reviewDecision: null,
    ...overrides,
  };
}

function reviewData(): PullRequestReviewData {
  return {
    pr: storedPr(),
    raw: { number: 1, title: "PR", html_url: "https://github.com/pytorch/pytorch/pull/1", state: "open", body: null, user: { login: "alice" }, base: { ref: "main", sha: "base", repo: { full_name: "pytorch/pytorch", clone_url: "git", html_url: "repo" } }, head: { ref: "branch", sha: "head", repo: null } },
    files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@" }],
    comments: [],
    issueComments: [],
    reviewSummaries: [],
    fileReviews: [],
  };
}

function fakeDeps(options: { submitFails?: boolean } = {}) {
  const calls: string[] = [];
  const savedMemory: Array<Omit<ReviewMemoryRecord, "id" | "createdAt">> = [];
  const reviewedPr = storedPr({ lastReviewedHeadSha: "head", lastReviewEvent: "COMMENT" });
  return {
    calls,
    savedMemory,
    deps: {
      async fetchPullRequestReviewData(requestRef: PullRequestRef) {
        calls.push(`fetch:${requestRef.number}`);
        return reviewData();
      },
      async markPullRequestReviewed(prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]) {
        calls.push(`mark:${prKey}:${headSha}:${event}`);
        return reviewedPr;
      },
      refFromBody(payload: unknown) {
        assert.equal(typeof payload, "object");
        calls.push("ref");
        return ref;
      },
      async saveReviewMemory(record: Omit<ReviewMemoryRecord, "id" | "createdAt">) {
        calls.push(`memory:${record.prKey}:${record.event}:${record.comments.length}`);
        savedMemory.push(record);
        return { ...record, id: "memory", createdAt: "now" };
      },
      async submitPullRequestReview(requestRef: PullRequestRef, payload: unknown) {
        calls.push(`submit:${requestRef.number}:${JSON.stringify(payload)}`);
        if (options.submitFails) throw new Error("GitHub 422");
        return { ok: true };
      },
    },
  };
}

const payload = {
  prUrl: "https://github.com/pytorch/pytorch/pull/1",
  headSha: "head",
  event: "COMMENT",
  body: " body ",
  comments: [{ draft_id: "draft-1", path: "a.ts", line: 10, side: "RIGHT", body: " issue " }],
};

test("review submit route API submits review, saves memory, and marks PR reviewed", async () => {
  const { deps, calls, savedMemory } = fakeDeps();

  const response = await createReviewSubmitRouteApi(deps).submit(payload);

  assert.deepEqual(response.result, { ok: true });
  assert.equal(response.pr?.lastReviewedHeadSha, "head");
  assert.equal(savedMemory[0]?.body, "body");
  assert.deepEqual(savedMemory[0]?.changeSet?.files.map((file) => file.path), ["a.ts"]);
  assert.deepEqual(calls, [
    "ref",
    "submit:1:{\"event\":\"COMMENT\",\"body\":\" body \",\"comments\":[{\"path\":\"a.ts\",\"line\":10,\"side\":\"RIGHT\",\"body\":\" issue \"}]}",
    "fetch:1",
    "memory:github.com/pytorch/pytorch#1:COMMENT:1",
    "mark:github.com/pytorch/pytorch#1:head:COMMENT",
  ]);
});

test("review submit route API wraps GitHub failures with inline diagnostics", async () => {
  const { deps, calls } = fakeDeps({ submitFails: true });

  await assert.rejects(createReviewSubmitRouteApi(deps).submit(payload), /GitHub 422[\s\S]*draft=draft-1 a\.ts:10 RIGHT/);
  assert.equal(calls.length, 2);
});

test("review submit route API validates event", async () => {
  const { deps } = fakeDeps();

  await assert.rejects(createReviewSubmitRouteApi(deps).submit({ ...payload, event: "BAD" }), /Expected review event/);
});
