import assert from "node:assert/strict";
import test from "node:test";

import { createActivityApi, estimateUsageSessions, MAX_HEARTBEAT_MS, renderActivityReport, resolveActivityLedgerPath, weekStartOf, type ActivityApiDeps, type GithubReview, type GithubReviewStore } from "../../src/activity-api.js";
import type { ReviewMemoryRecord, StoredPullRequest } from "../../src/types.js";

const PR = "github.com/pytorch/pytorch#100";

function memory(overrides: Partial<ReviewMemoryRecord>): ReviewMemoryRecord {
  return { id: "m", prKey: PR, headSha: "h", event: "APPROVE", body: "", comments: [], createdAt: "2026-09-10T10:00:00Z", ...overrides };
}

function githubReview(overrides: Partial<GithubReview>): GithubReview {
  return { id: "r1", prKey: "github.com/o/r#5", title: "GitHub-only PR", url: "https://github.com/o/r/pull/5", state: "APPROVED", at: "2026-09-10T09:00:00Z", ...overrides };
}

function harness(overrides: Partial<ActivityApiDeps> = {}) {
  let ledger = "";
  let now = "2026-09-10T12:00:00Z";
  let githubStore: GithubReviewStore | null = null;
  const reports: string[] = [];
  const deps: ActivityApiDeps = {
    readLedger: async () => ledger,
    appendLedger: async (line) => { ledger += line; },
    readUsageLog: async () => "",
    listReviewMemoryRecords: async () => [],
    listRecentPullRequests: async () => [{ key: PR, title: "Fix SDPA", url: "https://github.com/pytorch/pytorch/pull/100" } as StoredPullRequest],
    now: () => now,
    dayOf: (iso) => iso.slice(0, 10),
    startOfDay: (nowIso, daysAgo) => new Date(Date.parse(`${nowIso.slice(0, 10)}T00:00:00Z`) - daysAgo * 86_400_000).toISOString(),
    startOfYear: (nowIso) => `${nowIso.slice(0, 4)}-01-01T00:00:00.000Z`,
    readGithubReviews: async () => githubStore,
    writeGithubReviews: async (store) => { githubStore = store; },
    writeReport: async (markdown) => { reports.push(markdown); },
    ...overrides,
  };
  return { api: createActivityApi(deps), setNow: (iso: string) => { now = iso; }, ledger: () => ledger, appendRaw: (text: string) => { ledger += text; }, github: () => githubStore, reports };
}

test("heartbeats are validated, clamped, and only attribute review-surface time to a PR", async () => {
  const h = harness();
  await assert.rejects(h.api.heartbeat({ surface: "elsewhere", ms: 1000 }), /surface/);
  await assert.rejects(h.api.heartbeat({ surface: "review", ms: -5 }), /positive/);
  await assert.rejects(h.api.heartbeat({ surface: "review", ms: 1000, prKey: "../../etc" }), /prKey/);
  await h.api.heartbeat({ surface: "review", ms: 10 * 60 * 1000, prKey: PR });
  await h.api.heartbeat({ surface: "home", ms: 30_000, prKey: PR });
  const events = h.ledger().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => [event.surface, event.ms, event.prKey]), [["review", MAX_HEARTBEAT_MS, PR], ["home", 30_000, null]]);
});

test("summary joins measured time, workflow actions, and submitted reviews per day and per PR", async () => {
  const h = harness({ listReviewMemoryRecords: async () => [
    memory({ createdAt: "2026-09-10T11:00:00Z", event: "REQUEST_CHANGES", comments: [{} as never, {} as never] }),
    memory({ createdAt: "2026-09-09T11:00:00Z", event: "COMMENT", prKey: "github.com/o/r#5", disposition: "archived" }),
    memory({ createdAt: "2026-08-01T11:00:00Z", event: "APPROVE", prKey: "github.com/o/r#6" }),
  ] });
  h.setNow("2026-09-09T09:00:00Z");
  await h.api.heartbeat({ surface: "home", ms: 60_000 });
  h.setNow("2026-09-10T10:30:00Z");
  await h.api.heartbeat({ surface: "review", ms: 90_000, prKey: PR });
  await h.api.heartbeat({ surface: "review", ms: 30_000, prKey: PR });
  await h.api.recordAction({ action: "pre-review:accept", prKey: "github.com/pytorch/pytorch#200", title: "Add op", url: "https://github.com/pytorch/pytorch/pull/200" });
  await h.api.recordAction({ action: "triage:actionable", prKey: "github.com/pytorch/pytorch#300", title: "Bug", url: null });
  h.setNow("2026-09-10T12:00:00Z");

  const week = await h.api.summary("7d");
  assert.equal(week.trackingSince, "2026-09-09T09:00:00Z");
  assert.deepEqual([week.totals.activeMs, week.totals.reviewMs, week.totals.homeMs], [180_000, 120_000, 60_000]);
  assert.deepEqual(week.totals.reviews, { APPROVE: 0, REQUEST_CHANGES: 1, COMMENT: 0, ARCHIVED: 1 });
  assert.equal(week.totals.reviewComments, 2);
  assert.deepEqual([week.totals.preReview.accept, week.totals.triage], [1, 1]);
  assert.equal(week.totals.avgMsPerReviewedPr, 120_000, "archived-only and untimed PRs do not count");
  assert.equal(week.days.length, 7, "every day in range is present, including empty ones");
  assert.deepEqual(week.days[0], { date: "2026-09-04", activeMs: 0, estimatedMs: 0, reviews: 0, preReviews: 0, triage: 0 });
  assert.deepEqual(week.days.slice(-2).map((day) => [day.date, day.activeMs, day.reviews, day.preReviews, day.triage]), [["2026-09-09", 60_000, 0, 0, 0], ["2026-09-10", 120_000, 1, 1, 1]], "archived reviews are counted separately, not in the submitted-review trend");
  const top = week.prs.find((entry) => entry.prKey === PR);
  assert.deepEqual([top?.title, top?.ms, top?.reviews, top?.comments], ["Fix SDPA", 120_000, ["REQUEST_CHANGES"], 2]);
  assert.equal(week.prs.find((entry) => entry.prKey.endsWith("#200"))?.title, "Add op");

  const today = await h.api.summary("today");
  assert.equal(today.totals.activeMs, 120_000);
  assert.equal(today.totals.reviews.ARCHIVED, 0);
  assert.equal((await h.api.summary("all")).totals.reviews.APPROVE, 1);
});

test("time before measurement began is estimated from interactive usage bursts and kept separate", async () => {
  const usage = [
    { ts: "2026-09-01T10:00:00Z", source: "server", name: "/api/pr/open" },
    { ts: "2026-09-01T10:05:00Z", source: "server", name: "/api/pi/diagnostics" },
    { ts: "2026-09-01T10:08:00Z", source: "web", name: "ui:side-tab" },
    { ts: "2026-09-01T11:00:00Z", source: "server", name: "/api/draft-review/save" },
    { ts: "2026-09-09T10:00:00Z", source: "server", name: "/api/review/submit" },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.deepEqual(estimateUsageSessions(usage, "2026-09-05T00:00:00Z"), [{ at: "2026-09-01T10:00:00Z", ms: 8 * 60_000 + 180_000 }, { at: "2026-09-01T11:00:00Z", ms: 180_000 }]);

  const h = harness({ readUsageLog: async () => usage });
  h.setNow("2026-09-05T00:00:00Z");
  await h.api.heartbeat({ surface: "home", ms: 1000 });
  h.setNow("2026-09-10T12:00:00Z");
  const summary = await h.api.summary("30d");
  assert.equal(summary.totals.estimatedMs, 14 * 60_000);
  assert.equal(summary.totals.activeMs, 1000, "estimates never count as measured time");
  assert.equal(summary.days.find((day) => day.date === "2026-09-01")?.estimatedMs, 14 * 60_000);
});

test("a torn ledger line is skipped without hiding the rest of the history", async () => {
  const h = harness();
  await h.api.heartbeat({ surface: "home", ms: 5000 });
  h.appendRaw("{\"kind\":\"time\",\"at\":\"2026-09-10T11:59");
  assert.equal((await h.api.summary("today")).totals.activeMs, 5000);
});

test("the ledger path can be relocated, but never for isolated test/probe servers", () => {
  const base = { configuredPath: "~/vault/Review_Activity/review_activity.jsonl", defaultPath: "/state/state.activity.jsonl", home: "/Users/me" };
  assert.equal(resolveActivityLedgerPath({ ...base, env: {} }), "/Users/me/vault/Review_Activity/review_activity.jsonl");
  assert.equal(resolveActivityLedgerPath({ ...base, env: { PI_REVIEW_STATE_PATH: "/tmp/e2e.json" } }), "/state/state.activity.jsonl", "custom state keeps the ledger isolated");
  assert.equal(resolveActivityLedgerPath({ ...base, env: { PI_REVIEW_STATE_PATH: "/tmp/e2e.json", PI_REVIEW_ACTIVITY_PATH: "/x/ledger.jsonl" } }), "/x/ledger.jsonl", "an explicit env override always wins");
  assert.equal(resolveActivityLedgerPath({ ...base, configuredPath: undefined, env: {} }), "/state/state.activity.jsonl");
});

test("GitHub reviews merge with Pi Review history as one review per PR per day, strongest verdict", async () => {
  const h = harness({
    listReviewMemoryRecords: async () => [memory({ createdAt: "2026-09-10T10:00:00Z", event: "COMMENT", comments: [{} as never] })],
    fetchGithubReviews: async () => [
      githubReview({ id: "a", prKey: PR, state: "COMMENTED", at: "2026-09-10T10:00:05Z" }),
      githubReview({ id: "b", prKey: PR, state: "CHANGES_REQUESTED", at: "2026-09-10T11:00:00Z" }),
      githubReview({ id: "c", state: "COMMENTED", at: "2026-09-09T08:00:00Z" }),
      githubReview({ id: "d", state: "COMMENTED", at: "2026-09-09T08:05:00Z" }),
      githubReview({ id: "e", state: "APPROVED", at: "2026-09-10T09:00:00Z" }),
    ],
  });
  await h.api.sync();
  const week = await h.api.summary("7d");
  assert.deepEqual(week.totals.reviews, { APPROVE: 1, REQUEST_CHANGES: 1, COMMENT: 1, ARCHIVED: 0 }, "thread replies on one PR-day collapse into one review");
  assert.deepEqual(week.totals.reviewsVia, { piReview: 1, githubOnly: 2 });
  assert.equal(week.totals.reviewComments, 1);
  assert.deepEqual(week.prs.find((pr) => pr.prKey === PR)?.reviews, ["REQUEST_CHANGES"]);
  assert.equal(week.prs.find((pr) => pr.prKey === "github.com/o/r#5")?.title, "GitHub-only PR", "titles come from GitHub for PRs never opened here");
  assert.deepEqual(week.days.slice(-2).map((day) => [day.date, day.reviews]), [["2026-09-09", 1], ["2026-09-10", 2]]);
});

test("sync backfills a year once, then runs daily with overlap and dedupes by review id; reports are rewritten", async () => {
  const windows: Array<[string, string]> = [];
  let batch = [githubReview({ id: "a" }), githubReview({ id: "b", at: "2026-09-01T00:00:00Z" })];
  const h = harness({ fetchGithubReviews: async (from, to) => { windows.push([from, to]); return batch; } });
  const first = await h.api.sync();
  assert.deepEqual([first.added, first.total, first.skipped], [2, 2, false]);
  assert.equal(windows[0][0], new Date(Date.parse("2026-09-10T12:00:00Z") - 364 * 86_400_000).toISOString(), "first sync backfills ~a year");
  assert.equal((await h.api.sync()).skipped, true, "a second sync the same day is skipped");

  h.setNow("2026-09-12T12:00:00Z");
  batch = [githubReview({ id: "b", at: "2026-09-01T00:00:00Z" }), githubReview({ id: "c", at: "2026-09-12T08:00:00Z" })];
  const second = await h.api.sync();
  assert.deepEqual([second.added, second.total], [1, 3]);
  assert.equal(windows[1][0], "2026-09-07T12:00:00.000Z", "incremental sync re-reads three days before the last sync");
  assert.equal(h.github()?.coveredFrom, windows[0][0]);
  assert.equal(h.reports.length, 2);
  assert.match(h.reports[1], /^# Review activity 2026/);
  assert.equal((await h.api.sync({ force: true })).skipped, false, "force always syncs");
});

test("without a GitHub fetcher, sync is a no-op and the summary says it is disabled", async () => {
  const h = harness();
  assert.deepEqual(await h.api.sync({ force: true }), { added: 0, total: 0, syncedAt: null, skipped: true });
  assert.equal((await h.api.summary("year")).github.enabled, false);
  assert.deepEqual(h.reports, []);
});

test("year range and weekly trend: weeks start on Monday and sum their days", async () => {
  assert.equal(weekStartOf("2026-09-10"), "2026-09-07");
  assert.equal(weekStartOf("2026-09-07"), "2026-09-07");
  assert.equal(weekStartOf("2026-09-06"), "2026-08-31");
  const h = harness({ fetchGithubReviews: async () => [githubReview({ id: "x", at: "2026-01-05T10:00:00Z" }), githubReview({ id: "y", at: "2025-12-30T10:00:00Z", prKey: "github.com/o/r#9" })] });
  await h.api.sync();
  const year = await h.api.summary("year");
  assert.equal(year.from, "2026-01-01T00:00:00.000Z");
  assert.equal(year.totals.reviews.APPROVE, 1, "last year's review is outside the calendar-year range");
  assert.equal(year.weeks[0].weekStart, "2025-12-29", "Jan 1 2026 falls in the week starting Monday Dec 29");
  assert.equal(year.weeks.find((week) => week.weekStart === "2026-01-05")?.reviews, 1);
  assert.equal(year.weeks.reduce((sum, week) => sum + week.reviews, 0), 1);
});

test("the report shows totals, monthly and weekly tables, top PRs, and its method", async () => {
  const h = harness({ fetchGithubReviews: async () => [githubReview({ id: "x" })] });
  await h.api.heartbeat({ surface: "review", ms: 120_000, prKey: PR });
  await h.api.sync();
  const report = renderActivityReport(await h.api.summary("year"));
  assert.match(report, /\*\*Reviews:\*\* 1 \(1 approved/);
  assert.match(report, /0 through Pi Review, 1 directly on GitHub/);
  assert.match(report, /\| 2026-09 \| 1 \| 0 \| 0 \| 0\.0h \| — \|/);
  assert.match(report, /\| wk of 2026-09-07 \| 1 \|/);
  assert.match(report, /\[Fix SDPA\]\(https:\/\/github\.com\/pytorch\/pytorch\/pull\/100\) — 2 min/);
  assert.match(report, /lower bound/);
});
