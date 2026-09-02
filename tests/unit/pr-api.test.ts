import assert from "node:assert/strict";
import test from "node:test";

import { createPrApi } from "../../src/pr-api.js";
import type { AiReviewRecord, DraftReview, FileReviewState, FocusScanRecord, GuideReviewRecord, PullRequestRef, PullRequestReviewData, StoredPullRequest } from "../../src/types.js";

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
    fileReviews: [{ prKey: pr.key, path: "a.ts", fingerprint: "fp-a", viewed: false, updatedAt: "then" }],
  };
}

function fakeDeps() {
  const calls: string[] = [];
  const storedFileReviews: FileReviewState[] = [];
  const draftReview: DraftReview = { prKey: "github.com/pytorch/pytorch#1", headSha: "head", event: "COMMENT", body: "draft body", comments: [], updatedAt: "now" };
  const focusScan: FocusScanRecord = { id: "focus", prKey: "github.com/pytorch/pytorch#1", headSha: "head", answer: "focus", areaStates: {}, createdAt: "then", updatedAt: "now" };
  const aiReview: AiReviewRecord = { id: "ai", prKey: "github.com/pytorch/pytorch#1", headSha: "head", answer: "ai", createdAt: "then", updatedAt: "now" };
  const guideReview: GuideReviewRecord = { id: "guide", prKey: "github.com/pytorch/pytorch#1", headSha: "head", answer: "guide", createdAt: "then", updatedAt: "now" };
  return {
    calls,
    storedFileReviews,
    deps: {
      async cleanupPrWorktree(requestRef: PullRequestRef) {
        calls.push(`cleanup:${requestRef.number}`);
        return "/tmp/worktree";
      },
      async compareCommits(requestRef: PullRequestRef, baseSha: string, headSha: string) {
        calls.push(`compare:${requestRef.number}:${baseSha}:${headSha}`);
        return { files: [{ filename: "b.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ interdiff" }], totalCommits: 3 };
      },
      async compareCommitsLocally(requestRef: PullRequestRef, sinceSha: string, headSha: string, currentFiles: { filename: string }[]) {
        calls.push(`local-compare:${requestRef.number}:${sinceSha}:${headSha}:${currentFiles.map((file) => file.filename).join(",")}`);
        return { files: [{ filename: "c.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ local" }], totalCommits: 2, rewritten: false };
      },
      async fetchCommitChecks(requestRef: PullRequestRef, sha: string) {
        calls.push(`checks:${requestRef.number}:${sha}`);
        return { total: 5, success: 3, failure: 1, pending: 1, neutral: 0, failures: [{ name: "lint", url: "https://ci.example/lint" }] };
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
      async listFileReviews(prKey: string) {
        calls.push(`fileReviews:${prKey}`);
        return storedFileReviews;
      },
      async listFocusScans(prKey: string) {
        calls.push(`focus:${prKey}`);
        return [focusScan];
      },
      async listGuideReviews(prKey: string) {
        calls.push(`guide:${prKey}`);
        return [guideReview];
      },
      async listOverviews(prKey: string) {
        calls.push(`overview:${prKey}`);
        return [{ ...guideReview, id: "overview" }];
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

test("PR API activity refreshes the worktree, Pi context, and review response", async () => {
  const { deps, calls } = fakeDeps();

  const response = await createPrApi(deps).activity("url");

  assert.equal(response.worktreeDir, "/tmp/worktree");
  assert.equal(response.pr.title, "Stored PR");
  assert.equal(response.draftReview?.body, "draft body");
  assert.equal(response.focusScan?.id, "focus");
  assert.equal(response.aiReview?.id, "ai");
  assert.equal(response.guideReview?.id, "guide");
  assert.equal(response.overview?.id, "overview");
  assert.deepEqual(calls, [
    "parse:url",
    "fetch:1",
    "upsert:github.com/pytorch/pytorch#1",
    "prepare:1:git@github.com:pytorch/pytorch.git:head",
    "context:github.com/pytorch/pytorch#1:/tmp/worktree:head:a.ts",
    "draft:github.com/pytorch/pytorch#1",
    "focus:github.com/pytorch/pytorch#1",
    "ai:github.com/pytorch/pytorch#1",
    "guide:github.com/pytorch/pytorch#1",
    "overview:github.com/pytorch/pytorch#1",
    "fileReviews:github.com/pytorch/pytorch#1",
  ]);
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
    "prewarm:github.com/pytorch/pytorch#1:main-review,focus-review",
    "draft:github.com/pytorch/pytorch#1",
    "focus:github.com/pytorch/pytorch#1",
    "ai:github.com/pytorch/pytorch#1",
    "guide:github.com/pytorch/pytorch#1",
    "overview:github.com/pytorch/pytorch#1",
    "fileReviews:github.com/pytorch/pytorch#1",
  ]);
});

test("PR API open resolves viewed flags from stored file reviews only while the fingerprint matches", async () => {
  const { deps, storedFileReviews } = fakeDeps();
  storedFileReviews.push({ prKey: "github.com/pytorch/pytorch#1", path: "a.ts", fingerprint: "fp-a", viewed: true, updatedAt: "later" });

  const viewedResponse = await createPrApi(deps).open("url");
  assert.deepEqual(viewedResponse.fileReviews, [{ prKey: "github.com/pytorch/pytorch#1", path: "a.ts", fingerprint: "fp-a", viewed: true, updatedAt: "later" }]);

  // A stale fingerprint means the file changed since it was viewed, so the mark is dropped.
  storedFileReviews[0] = { ...storedFileReviews[0], fingerprint: "fp-old" };
  const staleResponse = await createPrApi(deps).open("url");
  assert.equal(staleResponse.fileReviews[0]?.viewed, false);
});

test("PR API interdiff prefers the local repo and filters unsafe file entries", async () => {
  const { deps, calls } = fakeDeps();

  const response = await createPrApi(deps).interdiff({ prUrl: "url", sinceSha: "abc1234", headSha: "def5678", files: [{ filename: "a.ts", patch: "+x" }, { filename: "../etc/passwd" }, { filename: "b.ts" }] });

  assert.deepEqual(response, {
    files: [{ filename: "c.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ local" }],
    totalCommits: 2,
    sinceSha: "abc1234",
    headSha: "def5678",
    source: "local-git",
    rewritten: false,
  });
  assert.deepEqual(calls, ["parse:url", "local-compare:1:abc1234:def5678:a.ts,b.ts"]);
});

test("PR API interdiff falls back to the compare API when the local repo cannot answer", async () => {
  const { deps, calls } = fakeDeps();
  const failing = {
    ...deps,
    async compareCommitsLocally(): Promise<never> {
      throw new Error("no cached repo");
    },
  };

  const response = await createPrApi(failing).interdiff({ prUrl: "url", sinceSha: "abc1234", headSha: "def5678" });

  assert.equal(response.source, "github");
  assert.equal(response.rewritten, false);
  assert.equal(response.totalCommits, 3);
  assert.deepEqual(calls, ["parse:url", "compare:1:abc1234:def5678"]);
});

test("PR API interdiff rejects rebase-noise compare results when local data is unavailable", async () => {
  const { deps } = fakeDeps();
  const failing = {
    ...deps,
    async compareCommits() {
      return { files: Array.from({ length: 40 }, (_, index) => ({ filename: `noise-${index}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 })), totalCommits: 614 };
    },
    async compareCommitsLocally(): Promise<never> {
      throw new Error("Commit abc1234 is no longer available locally or upstream");
    },
  };

  await assert.rejects(createPrApi(failing).interdiff({ prUrl: "url", sinceSha: "abc1234", headSha: "def5678", files: [{ filename: "a.ts" }, { filename: "b.ts" }] }), /no longer available locally or upstream/);
});

test("PR API interdiff surfaces the local error when both engines fail", async () => {
  const { deps } = fakeDeps();
  const failing = {
    ...deps,
    async compareCommits(): Promise<never> {
      throw new Error("gh: Not Found (HTTP 404)");
    },
    async compareCommitsLocally(): Promise<never> {
      throw new Error("Commit abc1234 is no longer available locally or upstream");
    },
  };

  await assert.rejects(createPrApi(failing).interdiff({ prUrl: "url", sinceSha: "abc1234", headSha: "def5678" }), /no longer available locally or upstream/);
});

test("PR API checks summarizes commit check runs", async () => {
  const { deps, calls } = fakeDeps();

  const response = await createPrApi(deps).checks({ prUrl: "url", sha: "def5678" });

  assert.equal(response.checks.total, 5);
  assert.deepEqual(response.checks.failures, [{ name: "lint", url: "https://ci.example/lint" }]);
  assert.deepEqual(calls, ["parse:url", "checks:1:def5678"]);
});

test("PR API interdiff and checks reject malformed payloads", async () => {
  const { deps } = fakeDeps();
  const prApi = createPrApi(deps);

  await assert.rejects(prApi.interdiff({ sinceSha: "abc1234", headSha: "def5678" }), /prUrl/);
  await assert.rejects(prApi.interdiff({ prUrl: "url", sinceSha: "not a sha", headSha: "def5678" }), /sinceSha/);
  await assert.rejects(prApi.interdiff({ prUrl: "url", sinceSha: "abc1234" }), /headSha/);
  await assert.rejects(prApi.checks({ prUrl: "url" }), /sha/);
});
