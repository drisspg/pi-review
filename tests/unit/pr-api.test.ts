import assert from "node:assert/strict";
import test from "node:test";

import { createPrApi } from "../../src/pr-api.js";
import type { AiReviewRecord, DraftReview, FocusScanRecord, PullRequestRef, PullRequestReviewData, StoredPullRequest } from "../../src/types.js";

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

function reviewData(pr = storedPr()): PullRequestReviewData {
  return {
    pr,
    raw: { number: 1, title: "PR", html_url: pr.url, state: "open", body: null, user: { login: "alice" }, base: { ref: "main", sha: "base", repo: { full_name: "pytorch/pytorch", clone_url: "git@github.com:pytorch/pytorch.git", html_url: "https://github.com/pytorch/pytorch" } }, head: { ref: "branch", sha: pr.headSha, repo: null } },
    files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@" }],
    comments: [],
    issueComments: [],
    reviewSummaries: [],
    fileReviews: [],
  };
}

function fakeDeps() {
  const calls: string[] = [];
  const draftReview: DraftReview = { prKey: "github.com/pytorch/pytorch#1", headSha: "head", event: "COMMENT", body: "draft body", comments: [], updatedAt: "now" };
  const focusScan: FocusScanRecord = { id: "focus", prKey: "github.com/pytorch/pytorch#1", headSha: "head", answer: "focus", areaStates: {}, createdAt: "then", updatedAt: "now" };
  const aiReview: AiReviewRecord = { id: "ai", prKey: "github.com/pytorch/pytorch#1", headSha: "head", answer: "ai", createdAt: "then", updatedAt: "now" };
  return {
    calls,
    deps: {
      async cleanupPrWorktree(requestRef: PullRequestRef) {
        calls.push(`cleanup:${requestRef.number}`);
        return "/tmp/worktree";
      },
      async disposePiSession(prKey: string) {
        calls.push(`dispose:${prKey}`);
      },
      async fetchPullRequestReviewData(requestRef: PullRequestRef) {
        calls.push(`fetch:${requestRef.number}`);
        return reviewData();
      },
      async getDraftReview(prKey: string) {
        calls.push(`draft:${prKey}`);
        return draftReview;
      },
      async listAiReviews(prKey: string) {
        calls.push(`ai:${prKey}`);
        return [aiReview];
      },
      async listFocusScans(prKey: string) {
        calls.push(`focus:${prKey}`);
        return [focusScan];
      },
      parsePullRequestRef(input: string) {
        calls.push(`parse:${input}`);
        return ref;
      },
      async preparePrWorktree(requestRef: PullRequestRef, cloneUrl: string, headSha: string) {
        calls.push(`prepare:${requestRef.number}:${cloneUrl}:${headSha}`);
        return "/tmp/worktree";
      },
      prewarmPiSession(prKey: string, purposes: string[]) {
        calls.push(`prewarm:${prKey}:${purposes.join(",")}`);
      },
      async registerPiSessionContext(prKey: string, cwd: string, context: { headSha: string; files: PullRequestReviewData["files"] }) {
        calls.push(`context:${prKey}:${cwd}:${context.headSha}:${context.files.map((file) => file.filename).join(",")}`);
      },
      async removePullRequest(prKey: string) {
        calls.push(`remove:${prKey}`);
      },
      async upsertPullRequest(pr: StoredPullRequest) {
        calls.push(`upsert:${pr.key}`);
        return { ...pr, title: "Stored PR" };
      },
    },
  };
}

test("PR API parse delegates to injected parser", () => {
  const { deps, calls } = fakeDeps();

  assert.deepEqual(createPrApi(deps).parse("https://github.com/pytorch/pytorch/pull/1"), { ref });
  assert.deepEqual(calls, ["parse:https://github.com/pytorch/pytorch/pull/1"]);
});

test("PR API cleanup disposes session before worktree cleanup and state removal", async () => {
  const { deps, calls } = fakeDeps();

  assert.deepEqual(await createPrApi(deps).cleanup("url"), { ok: true, prKey: "github.com/pytorch/pytorch#1", worktreeDir: "/tmp/worktree" });
  assert.deepEqual(calls, ["parse:url", "dispose:github.com/pytorch/pytorch#1", "cleanup:1", "remove:github.com/pytorch/pytorch#1"]);
});

test("PR API activity fetches, upserts, and hydrates review response", async () => {
  const { deps, calls } = fakeDeps();

  const response = await createPrApi(deps).activity("url");

  assert.equal(response.pr.title, "Stored PR");
  assert.equal(response.draftReview?.body, "draft body");
  assert.equal(response.focusScan?.id, "focus");
  assert.equal(response.aiReview?.id, "ai");
  assert.deepEqual(calls, ["parse:url", "fetch:1", "upsert:github.com/pytorch/pytorch#1", "draft:github.com/pytorch/pytorch#1", "focus:github.com/pytorch/pytorch#1", "ai:github.com/pytorch/pytorch#1"]);
});

test("PR API open prepares worktree, registers Pi cwd, prewarms sessions, and hydrates response", async () => {
  const { deps, calls } = fakeDeps();

  const response = await createPrApi(deps).open("url");

  assert.equal(response.worktreeDir, "/tmp/worktree");
  assert.equal(response.pr.title, "Stored PR");
  assert.deepEqual(calls, [
    "parse:url",
    "fetch:1",
    "upsert:github.com/pytorch/pytorch#1",
    "prepare:1:git@github.com:pytorch/pytorch.git:head",
    "context:github.com/pytorch/pytorch#1:/tmp/worktree:head:a.ts",
    "prewarm:github.com/pytorch/pytorch#1:main-review,focus-review,chat,inline-chat,focus-chat",
    "draft:github.com/pytorch/pytorch#1",
    "focus:github.com/pytorch/pytorch#1",
    "ai:github.com/pytorch/pytorch#1",
  ]);
});
