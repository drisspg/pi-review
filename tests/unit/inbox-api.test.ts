import assert from "node:assert/strict";
import test from "node:test";

import { applyLatestActivity, buildInboxResponse, createInboxApi, isRateLimitError, rankInbox, refreshSnapshot, REFRESH_BUDGET, type InboxApiDeps, type InboxSnapshot } from "../../src/inbox-api.js";
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

function viewerPr(overrides: Partial<ViewerPullRequest>): ViewerPullRequest {
  return { key: "o/r#1", repo: "o/r", number: 1, title: "mine", url: "https://github.com/o/r/pull/1", state: "OPEN", closedAt: null, isDraft: false, reviewDecision: null, mergeable: "MERGEABLE", checks: "SUCCESS", failingChecks: [], reviewers: [], updatedAt: NOW, headSha: "h", localPrKey: null, ...overrides };
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

type Harness = InboxApiDeps & { calls: string[]; stored: InboxSnapshot | null; timers: Array<{ callback: () => void; ms: number }>; clock: { now: string }; notifications: GitHubNotification[] };

function harness(overrides: Partial<InboxApiDeps> = {}): Harness {
  const calls: string[] = [];
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const clock = { now: NOW };
  const h: Harness = {
    calls,
    stored: null,
    timers,
    clock,
    notifications: [
      notification({ id: "a", reason: "mention", latestCommentUrl: "https://api.github.com/repos/o/r/issues/comments/1" }),
      notification({ id: "b", reason: "review_requested", subjectNumber: 2 }),
    ],
    async fetchNotifications() {
      calls.push("notifications");
      return h.notifications;
    },
    async fetchSubjectSnapshots(refs) {
      calls.push(`snapshots:${refs.map((ref) => `${ref.repo}#${ref.number}`).join(",")}`);
      return refs.map((ref) => snapshot({ key: `${ref.repo}#${ref.number}`, url: `https://github.com/${ref.repo}/pull/${ref.number}` }));
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
      return scope === "open" ? [viewerPr({})] : [viewerPr({ key: "o/r#2", number: 2, title: "shipped", state: "MERGED", closedAt: NOW })];
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
    async readSnapshot() {
      calls.push("read");
      return h.stored;
    },
    async writeSnapshot(snapshot) {
      calls.push("write");
      h.stored = snapshot;
    },
    now: () => clock.now,
    setTimer(callback, ms) {
      timers.push({ callback, ms });
      return () => {
        const index = timers.findIndex((timer) => timer.callback === callback);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    staleMs: 60_000,
    activeWindowMs: 15 * 60_000,
    backlogDelayMs: 10_000,
    rateLimitPauseMs: 10 * 60_000,
    ...overrides,
  };
  return h;
}

function fetchCalls(h: Harness): string[] {
  return h.calls.filter((call) => !["read", "write"].includes(call));
}

function minutesLater(minutes: number): string {
  return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

test("refreshSnapshot: first cycle lists, enriches within budget, and fetches only the open PR scope", async () => {
  const h = harness();
  const { snapshot: first, rateLimited } = await refreshSnapshot(h, null);
  assert.equal(rateLimited, false);
  assert.deepEqual(fetchCalls(h), ["notifications", "snapshots:o/r#1,o/r#2", "latest:https://api.github.com/repos/o/r/issues/comments/1:viewer", "prs:viewer:open"]);
  assert.equal(first.latest.a?.latest.author, "pytorchmergebot");
  assert.deepEqual(first.viewerPrs.open.map((pr) => pr.key), ["o/r#1"]);
  assert.equal(first.viewerPrs.closedAt, null);
  assert.equal(first.backlog, 1, "closed PRs are still owed");

  h.calls.length = 0;
  h.clock.now = minutesLater(0.2);
  const { snapshot: second } = await refreshSnapshot(h, first);
  assert.deepEqual(fetchCalls(h), ["prs:viewer:recently-closed"], "continuation cycle skips the list (fresh) and drains the backlog");
  assert.equal(second.notificationsAt, first.notificationsAt);
  assert.equal(second.backlog, 0);
  assert.equal(second.viewerPrs.closed[0].state, "MERGED");
});

test("refreshSnapshot re-fetches only changed threads once the list is stale", async () => {
  const h = harness();
  const { snapshot: first } = await refreshSnapshot(h, null);
  h.clock.now = minutesLater(0.5);
  const { snapshot: second } = await refreshSnapshot(h, first);
  h.calls.length = 0;
  h.clock.now = minutesLater(2);
  h.notifications = [h.notifications[0], { ...h.notifications[1], updatedAt: minutesLater(1.5) }, notification({ id: "c", reason: "comment", subjectNumber: 3 })];
  const { snapshot: third } = await refreshSnapshot(h, second);
  assert.deepEqual(fetchCalls(h), ["notifications", "snapshots:o/r#2,o/r#3"], "thread a keeps its snapshot and latest row; viewer PRs are within TTL");
  assert.equal(third.subjects["o/r#1"], first.subjects["o/r#1"]);
  assert.equal(third.latest.a, first.latest.a);
  assert.equal(third.viewerPrs.open, second.viewerPrs.open);
});

test("refreshSnapshot spends at most the budget per cycle and reports the backlog", async () => {
  const h = harness();
  h.notifications = Array.from({ length: 50 }, (_, index) => notification({ id: `n${index}`, reason: "mention", subjectNumber: index + 1, latestCommentUrl: `https://api.github.com/c/${index}`, updatedAt: new Date(Date.parse(NOW) - index * 60_000).toISOString() }));
  const { snapshot: first } = await refreshSnapshot(h, null);
  const snapshotCall = h.calls.find((call) => call.startsWith("snapshots:")) ?? "";
  assert.equal(snapshotCall.split(",").length, REFRESH_BUDGET.subjects);
  assert.ok(snapshotCall.startsWith("snapshots:o/r#1,o/r#2"), "most recent subjects first");
  const latestCall = h.calls.find((call) => call.startsWith("latest:")) ?? "";
  assert.equal(latestCall.split(",").length, REFRESH_BUDGET.latest);
  assert.equal(first.backlog, (50 - REFRESH_BUDGET.subjects) + (50 - REFRESH_BUDGET.latest) + 1);

  h.calls.length = 0;
  h.clock.now = minutesLater(0.2);
  const { snapshot: second } = await refreshSnapshot(h, first);
  assert.equal(fetchCalls(h)[0], "snapshots:" + Array.from({ length: 10 }, (_, index) => `o/r#${index + 41}`).join(","), "continues with the remaining subjects");
  assert.equal(Object.keys(second.subjects).length, 50);
  assert.equal(second.backlog, 50 - 2 * REFRESH_BUDGET.latest);
});

test("refreshSnapshot drops threads that left the inbox and re-checks subjects past their TTL", async () => {
  const h = harness();
  const { snapshot: first } = await refreshSnapshot(h, null);
  h.calls.length = 0;
  h.clock.now = minutesLater(20);
  h.notifications = [h.notifications[0]];
  const { snapshot: second } = await refreshSnapshot(h, first);
  assert.deepEqual(Object.keys(second.subjects), ["o/r#1"]);
  assert.deepEqual(fetchCalls(h), ["notifications", "snapshots:o/r#1", "prs:viewer:open"]);
});

test("refreshSnapshot keeps previous data, records warnings, and flags rate limits", async () => {
  const h = harness();
  const { snapshot: first } = await refreshSnapshot(h, null);
  h.fetchViewerPullRequests = async () => {
    throw new Error("Command failed: gh api graphql -f query=... \ngh: HTTP 504");
  };
  h.clock.now = minutesLater(30);
  const { snapshot: second, rateLimited } = await refreshSnapshot(h, first);
  assert.equal(rateLimited, false);
  assert.deepEqual(second.viewerPrs.open, first.viewerPrs.open);
  assert.deepEqual(second.warnings, ["Could not refresh your open PRs (HTTP 504); showing what was loaded before."]);

  h.fetchNotifications = async () => {
    throw new Error("gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)");
  };
  h.clock.now = minutesLater(32);
  const limited = await refreshSnapshot(h, second);
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.snapshot.notifications.length, 2, "previous list is kept when the re-list fails");
  assert.match(limited.snapshot.warnings[0], /^Could not refresh notifications \(You have exceeded a secondary rate limit/);
});

test("isRateLimitError recognises GitHub's primary and secondary limit messages", () => {
  assert.equal(isRateLimitError(new Error("gh: You have exceeded a secondary rate limit")), true);
  assert.equal(isRateLimitError(new Error("gh: API rate limit exceeded for user ID 1 (HTTP 403)")), true);
  assert.equal(isRateLimitError(new Error("gh: HTTP 429")), true);
  assert.equal(isRateLimitError(new Error("gh: HTTP 504")), false);
});

test("buildInboxResponse links saved reviews and reports refresh state", () => {
  const snap: InboxSnapshot = { version: 2, login: "viewer", fetchedAt: NOW, notificationsAt: NOW, notifications: [notification({ id: "a", reason: "mention" })], subjects: { "o/r#1": { at: NOW, snapshot: snapshot({}) } }, latest: {}, viewerPrs: { openAt: NOW, closedAt: null, open: [viewerPr({})], closed: [] }, backlog: 3, warnings: ["w"] };
  const response = buildInboxResponse(snap, [localPr], NOW, true);
  assert.equal(response.refreshing, true);
  assert.equal(response.backlog, 3);
  assert.equal(response.items[0].localPrKey, "github.com/o/r#1");
  assert.equal(response.myPrs[0].localPrKey, "github.com/o/r#1");
  assert.deepEqual(response.warnings, ["w"]);
});

test("inbox API answers immediately, refreshes in the background, and persists the snapshot", async () => {
  const h = harness();
  const api = createInboxApi(h);

  const cold = await api.inbox();
  assert.equal(cold.fetchedAt, null);
  assert.equal(cold.refreshing, true);
  assert.deepEqual(cold.items, []);

  await api.settle();
  assert.equal(h.stored?.notifications.length, 2, "snapshot persisted to disk");
  const warm = await api.inbox();
  assert.equal(warm.fetchedAt, NOW);
  assert.equal(warm.items.length, 2);
  assert.equal(warm.items.find((item) => item.id === "a")?.latest?.author, "pytorchmergebot");
  assert.equal(h.calls.filter((call) => call === "notifications").length, 1, "warm request did not re-list");
  assert.equal(warm.backlog, 1, "closed PRs still owed");
  assert.equal(warm.refreshing, true, "a request while backlog remains kicks off the continuation");
  await api.settle();
  assert.equal((await api.inbox()).backlog, 0);
  assert.equal(h.timers.at(-1)?.ms, 60_000, "with no backlog the next background refresh waits for the stale boundary");
});

test("inbox API schedules quick continuation cycles while backlog remains", async () => {
  const h = harness();
  h.notifications = Array.from({ length: 50 }, (_, index) => notification({ id: `n${index}`, reason: "mention", subjectNumber: index + 1 }));
  const api = createInboxApi(h);
  await api.inbox();
  await api.settle();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 10_000, "backlog → continue in 10s, not 60s");
  h.clock.now = minutesLater(0.2);
  h.timers.shift()?.callback();
  await api.settle();
  assert.equal(Object.keys(h.stored?.subjects ?? {}).length, 50);
});

test("inbox API serves a persisted snapshot across restarts and refreshes it when stale", async () => {
  const seed = harness();
  const seedApi = createInboxApi(seed);
  await seedApi.inbox();
  await seedApi.settle();
  await seedApi.settle();

  const h = harness();
  h.stored = seed.stored;
  h.clock.now = minutesLater(5);
  const api = createInboxApi(h);
  const served = await api.inbox();
  assert.equal(served.items.length, 2, "old snapshot is served instantly");
  assert.equal(served.fetchedAt, NOW);
  assert.equal(served.refreshing, true, "…while a refresh runs because it is older than staleMs");
  await api.settle();
  assert.equal((await api.inbox()).fetchedAt, minutesLater(5));
});

test("inbox API ignores snapshots written by an older format", async () => {
  const h = harness();
  h.stored = { version: 1 } as unknown as InboxSnapshot;
  const api = createInboxApi(h);
  const cold = await api.inbox();
  assert.equal(cold.fetchedAt, null);
  await api.settle();
  assert.equal(h.stored?.version, 2);
});

test("inbox API background timer refreshes while active and stops once idle", async () => {
  const h = harness();
  const api = createInboxApi(h);
  await api.inbox();
  await api.settle();
  h.clock.now = minutesLater(0.3);
  h.timers.shift()?.callback();
  await api.settle();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 60_000);

  h.clock.now = minutesLater(1.5);
  h.timers.shift()?.callback();
  await api.settle();
  assert.equal(h.calls.filter((call) => call === "notifications").length, 2, "stale list re-read on the timer");
  assert.equal(h.timers.length, 1, "rescheduled while within the active window");

  h.clock.now = minutesLater(60);
  h.timers.shift()?.callback();
  await api.settle();
  assert.equal(h.timers.length, 0, "no more refreshes once nobody has asked for the inbox in a while");
});

test("inbox API shares one in-flight refresh and force-refresh re-lists notifications", async () => {
  const h = harness();
  const api = createInboxApi(h);
  await Promise.all([api.inbox(), api.inbox({ refresh: true }), api.inbox()]);
  await api.settle();
  assert.equal(h.calls.filter((call) => call === "notifications").length, 1);

  h.calls.length = 0;
  await api.inbox({ refresh: true });
  await api.settle();
  assert.equal(fetchCalls(h)[0], "notifications", "force re-lists even though the list is fresh");
  assert.ok(!fetchCalls(h).some((call) => call.startsWith("snapshots:")), "unchanged subjects are not re-fetched even on force");
});

test("inbox API pauses GitHub traffic after a rate limit and says so", async () => {
  const h = harness();
  const api = createInboxApi(h);
  await api.inbox();
  await api.settle();
  await api.settle();
  h.fetchNotifications = async () => {
    throw new Error("gh: You have exceeded a secondary rate limit (HTTP 403)");
  };
  h.clock.now = minutesLater(2);
  await api.inbox({ refresh: true });
  await api.settle();
  const calls = h.calls.filter((call) => call === "notifications").length;

  h.clock.now = minutesLater(3);
  const paused = await api.inbox({ refresh: true });
  await api.settle();
  assert.equal(paused.pausedUntil, minutesLater(12));
  assert.ok(paused.warnings.some((warning) => warning.startsWith("GitHub reported a rate limit; inbox refreshes are paused")));
  assert.equal(paused.items.length, 2, "last good snapshot still served");
  assert.equal(h.calls.filter((call) => call === "notifications").length, calls, "no GitHub calls while paused");
  assert.equal(h.timers.at(-1)?.ms, 9 * 60_000, "next attempt waits for the pause to end");

  h.fetchNotifications = async () => {
    h.calls.push("notifications");
    return h.notifications;
  };
  h.clock.now = minutesLater(13);
  const resumed = await api.inbox({ refresh: true });
  assert.equal(resumed.pausedUntil, null);
  await api.settle();
  assert.equal(h.calls.filter((call) => call === "notifications").length, calls + 1);
});

test("inbox API marks threads done and drops them from the persisted snapshot", async () => {
  const h = harness();
  const api = createInboxApi(h);
  await api.inbox();
  await api.settle();

  assert.deepEqual(await api.done({ threadIds: ["a"] }), { done: ["a"] });
  assert.ok(h.calls.includes("done:a"));
  assert.deepEqual(h.stored?.notifications.map((notification) => notification.id), ["b"]);
  assert.deepEqual((await api.inbox()).items.map((item) => item.id), ["b"]);

  assert.deepEqual(await api.mute({ threadId: "b" }), { muted: ["b"] });
  assert.deepEqual(h.calls.filter((call) => call.startsWith("mute:") || call.startsWith("done:")), ["done:a", "mute:b", "done:b"]);
  assert.deepEqual((await api.inbox()).items, []);
});

test("inbox API rejects malformed thread ids", async () => {
  const api = createInboxApi(harness());
  await assert.rejects(api.done({}), /threadIds is required/);
  await assert.rejects(api.done({ threadIds: [""] }), /non-empty strings/);
});
