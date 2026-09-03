import assert from "node:assert/strict";
import test from "node:test";

import { applyLatestActivity, createInboxApi, rankInbox, type InboxApiDeps } from "../../src/inbox-api.js";
import type { GitHubNotification, InboxSubjectSnapshot, StoredPullRequest, ViewerPullRequest } from "../../src/types.js";

const NOW = "2026-09-03T12:00:00Z";

function notification(overrides: Partial<GitHubNotification>): GitHubNotification {
  return {
    id: "1",
    reason: "subscribed",
    unread: true,
    updatedAt: "2026-09-03T11:00:00Z",
    repo: "o/r",
    subjectKind: "pr",
    subjectNumber: 1,
    subjectTitle: "title",
    latestCommentUrl: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<InboxSubjectSnapshot>): InboxSubjectSnapshot {
  return {
    key: "o/r#1",
    kind: "pr",
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    isDraft: false,
    author: "alice",
    reviewDecision: null,
    checks: "SUCCESS",
    updatedAt: NOW,
    ...overrides,
  };
}

const localPr = { key: "github.com/o/r#1", url: "https://github.com/o/r/pull/1" } as StoredPullRequest;

test("rankInbox puts mentions above review requests and FYI comments", () => {
  const { items, tiers } = rankInbox([
    notification({ id: "comment", reason: "comment", subjectNumber: 3 }),
    notification({ id: "review", reason: "review_requested", subjectNumber: 2 }),
    notification({ id: "mention", reason: "mention", subjectNumber: 1 }),
  ], [snapshot({ key: "o/r#1" }), snapshot({ key: "o/r#2" }), snapshot({ key: "o/r#3" })], [], NOW);

  assert.deepEqual(items.map((item) => item.id), ["mention", "review", "comment"]);
  assert.deepEqual(items.map((item) => item.tier), ["needs-you", "review-requests", "fyi"]);
  assert.deepEqual(tiers, { "needs-you": 1, "review-requests": 1, "your-prs": 0, fyi: 1, resolved: 0 });
});

test("rankInbox demotes review requests on merged PRs to resolved but keeps fresh mentions", () => {
  const { items } = rankInbox([
    notification({ id: "stale-review", reason: "review_requested", subjectNumber: 1 }),
    notification({ id: "fresh-mention", reason: "mention", subjectNumber: 2 }),
    notification({ id: "old-mention", reason: "mention", subjectNumber: 3, updatedAt: "2026-08-20T00:00:00Z" }),
  ], [
    snapshot({ key: "o/r#1", state: "MERGED" }),
    snapshot({ key: "o/r#2", state: "CLOSED" }),
    snapshot({ key: "o/r#3", state: "CLOSED" }),
  ], [], NOW);

  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get("stale-review")?.tier, "resolved");
  assert.deepEqual(byId.get("stale-review")?.why, ["Review requested", "Merged"]);
  assert.equal(byId.get("fresh-mention")?.tier, "needs-you");
  assert.equal(byId.get("old-mention")?.tier, "resolved");
});

test("rankInbox treats review requests on drafts as FYI and explains CI/approval state", () => {
  const { items } = rankInbox([
    notification({ id: "draft", reason: "review_requested", subjectNumber: 1 }),
    notification({ id: "approved", reason: "review_requested", subjectNumber: 2 }),
    notification({ id: "clean", reason: "review_requested", subjectNumber: 3 }),
  ], [
    snapshot({ key: "o/r#1", isDraft: true }),
    snapshot({ key: "o/r#2", reviewDecision: "APPROVED", checks: "FAILURE" }),
    snapshot({ key: "o/r#3" }),
  ], [], NOW);

  assert.deepEqual(items.map((item) => item.id), ["clean", "approved", "draft"]);
  assert.equal(items[2].tier, "fyi");
  assert.deepEqual(items[2].why, ["Review requested", "Still a draft"]);
  assert.deepEqual(items[1].why, ["Review requested", "CI failing", "Already approved"]);
});

test("rankInbox boosts your PRs with failing CI and links saved reviews", () => {
  const { items } = rankInbox([
    notification({ id: "mine-broken", reason: "author", subjectNumber: 1 }),
    notification({ id: "mine-quiet", reason: "author", subjectNumber: 2 }),
  ], [snapshot({ key: "o/r#1", checks: "FAILURE" }), snapshot({ key: "o/r#2" })], [localPr], NOW);

  assert.deepEqual(items.map((item) => item.id), ["mine-broken", "mine-quiet"]);
  assert.equal(items[0].localPrKey, "github.com/o/r#1");
  assert.equal(items[1].localPrKey, null);
  assert.deepEqual(items[0].why, ["Activity on your PR", "CI failing"]);
});

test("rankInbox falls back to a GitHub URL when a subject has no snapshot", () => {
  const { items } = rankInbox([
    notification({ id: "issue", reason: "comment", subjectKind: "issue", subjectNumber: 9 }),
    notification({ id: "release", reason: "subscribed", subjectKind: "other", subjectNumber: null, subjectTitle: "v1.0" }),
  ], [], [], NOW);

  assert.equal(items[0].url, "https://github.com/o/r/issues/9");
  assert.equal(items[0].state, null);
  assert.equal(items[1].url, "https://github.com/o/r/notifications");
});

test("applyLatestActivity sinks bot chatter below human pings", () => {
  const { items } = rankInbox([
    notification({ id: "bot", reason: "mention", subjectNumber: 1, updatedAt: "2026-09-03T11:30:00Z" }),
    notification({ id: "human", reason: "mention", subjectNumber: 2, updatedAt: "2026-09-03T11:00:00Z" }),
  ], [snapshot({ key: "o/r#1" }), snapshot({ key: "o/r#2" })], [], NOW);
  assert.deepEqual(items.map((item) => item.id), ["bot", "human"]);

  const enriched = applyLatestActivity(items, new Map([
    ["bot", { author: "pytorch-bot[bot]", bot: true, pingsViewer: false, snippet: "rebase", url: "u1" }],
    ["human", { author: "alice", bot: false, pingsViewer: true, snippet: "@viewer thoughts?", url: "u2" }],
  ]));
  assert.deepEqual(enriched.map((item) => item.id), ["human", "bot"]);
  assert.deepEqual(enriched[0].why, ["You were mentioned", "alice pinged you"]);
  assert.deepEqual(enriched[1].why, ["You were mentioned", "Latest activity is pytorch-bot[bot]"]);
  assert.equal(items[0].latest, null, "input rows are not mutated");
});

function deps(overrides: Partial<InboxApiDeps> = {}): InboxApiDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    cacheMs: 60_000,
    async fetchNotifications() {
      calls.push("notifications");
      return [notification({ id: "a", reason: "mention", latestCommentUrl: "https://api.github.com/repos/o/r/issues/comments/1" }), notification({ id: "b", reason: "comment", subjectKind: "other", subjectNumber: null })];
    },
    async fetchSubjectSnapshots(refs) {
      calls.push(`snapshots:${refs.map((ref) => `${ref.repo}#${ref.number}`).join(",")}`);
      return [snapshot({})];
    },
    async fetchLatestActivity(urls, login) {
      calls.push(`latest:${urls.join(",")}:${login}`);
      return new Map(urls.map((url) => [url, { author: "pytorchmergebot", bot: true, pingsViewer: false, snippet: "merge started", url }]));
    },
    async fetchViewerLogin() {
      return "viewer";
    },
    async fetchViewerPullRequests(login, scope) {
      calls.push(`prs:${login}:${scope}`);
      if (scope === "recently-closed") return [{ key: "o/r#2", repo: "o/r", number: 2, title: "shipped", url: "https://github.com/o/r/pull/2", state: "MERGED", closedAt: NOW, isDraft: false, reviewDecision: "APPROVED", mergeable: "UNKNOWN", checks: "SUCCESS", failingChecks: [], reviewers: [], updatedAt: NOW, headSha: "h2", localPrKey: null } satisfies ViewerPullRequest];
      return [{ key: "o/r#1", repo: "o/r", number: 1, title: "mine", url: "https://github.com/o/r/pull/1", state: "OPEN", closedAt: null, isDraft: false, reviewDecision: null, mergeable: "MERGEABLE", checks: "SUCCESS", failingChecks: [], reviewers: [], updatedAt: NOW, headSha: "h", localPrKey: null } satisfies ViewerPullRequest];
    },
    async listRecentPullRequests() {
      return [localPr];
    },
    async markNotificationDone(threadId) {
      calls.push(`done:${threadId}`);
    },
    async unsubscribeNotification(threadId) {
      calls.push(`mute:${threadId}`);
    },
    now: () => NOW,
    ...overrides,
  };
}

test("inbox API batches snapshot lookups, links local PRs, and caches until refresh", async () => {
  const d = deps();
  const api = createInboxApi(d);

  const first = await api.inbox();
  assert.equal(first.login, "viewer");
  assert.equal(first.items.length, 2);
  assert.equal(first.myPrs[0].localPrKey, "github.com/o/r#1");
  assert.deepEqual(first.recentlyClosedPrs.map((pr) => [pr.key, pr.state]), [["o/r#2", "MERGED"]]);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(d.calls, ["notifications", "snapshots:o/r#1", "prs:viewer:open", "prs:viewer:recently-closed", "latest:https://api.github.com/repos/o/r/issues/comments/1:viewer"]);
  assert.deepEqual(first.items[0].latest, { author: "pytorchmergebot", bot: true, pingsViewer: false, snippet: "merge started", url: "https://api.github.com/repos/o/r/issues/comments/1" });
  assert.deepEqual(first.items[0].why, ["You were mentioned", "Latest activity is pytorchmergebot"]);

  await api.inbox();
  assert.equal(d.calls.length, 5, "second call is served from cache");
  await api.inbox({ refresh: true });
  assert.equal(d.calls.length, 10);
});

test("inbox API shares one in-flight load between concurrent callers", async () => {
  const d = deps({ cacheMs: 0 });
  const api = createInboxApi(d);
  const [a, b] = await Promise.all([api.inbox(), api.inbox({ refresh: true })]);
  assert.equal(a, b);
  assert.equal(d.calls.filter((call) => call === "notifications").length, 1);
  await api.inbox();
  assert.equal(d.calls.filter((call) => call === "notifications").length, 2, "no cache configured, so the next call reloads");
});

test("inbox API surfaces enrichment failures as warnings instead of failing the inbox", async () => {
  const api = createInboxApi(deps({
    async fetchSubjectSnapshots() {
      throw new Error("graphql down");
    },
    async fetchViewerPullRequests() {
      throw new Error("search down");
    },
  }));

  const response = await api.inbox();
  assert.equal(response.items.length, 2);
  assert.deepEqual(response.myPrs, []);
  assert.deepEqual(response.warnings, ["Could not load PR/issue state: graphql down", "Could not load your open PRs: search down", "Could not load your recently closed PRs: search down"]);
});

test("inbox API marks threads done and drops them from the cached inbox", async () => {
  const d = deps();
  const api = createInboxApi(d);
  await api.inbox();

  assert.deepEqual(await api.done({ threadIds: ["a"] }), { done: ["a"] });
  assert.ok(d.calls.includes("done:a"));
  const cached = await api.inbox();
  assert.deepEqual(cached.items.map((item) => item.id), ["b"]);
  assert.equal(cached.tiers["needs-you"], 0);

  assert.deepEqual(await api.mute({ threadId: "b" }), { muted: ["b"] });
  assert.deepEqual(d.calls.slice(-2), ["mute:b", "done:b"]);
  assert.deepEqual((await api.inbox()).items, []);
});

test("inbox API rejects malformed thread ids", async () => {
  const api = createInboxApi(deps());
  await assert.rejects(api.done({}), /threadIds is required/);
  await assert.rejects(api.done({ threadIds: [""] }), /non-empty strings/);
});
