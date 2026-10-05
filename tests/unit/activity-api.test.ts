import assert from "node:assert/strict";
import test from "node:test";

import { createActivityApi, estimateUsageSessions, MAX_HEARTBEAT_MS, resolveActivityLedgerPath, type ActivityApiDeps } from "../../src/activity-api.js";
import type { ReviewMemoryRecord, StoredPullRequest } from "../../src/types.js";

const PR = "github.com/pytorch/pytorch#100";

function memory(overrides: Partial<ReviewMemoryRecord>): ReviewMemoryRecord {
  return { id: "m", prKey: PR, headSha: "h", event: "APPROVE", body: "", comments: [], createdAt: "2026-09-10T10:00:00Z", ...overrides };
}

function harness(overrides: Partial<ActivityApiDeps> = {}) {
  let ledger = "";
  let now = "2026-09-10T12:00:00Z";
  const deps: ActivityApiDeps = {
    readLedger: async () => ledger,
    appendLedger: async (line) => { ledger += line; },
    readUsageLog: async () => "",
    listReviewMemoryRecords: async () => [],
    listRecentPullRequests: async () => [{ key: PR, title: "Fix SDPA", url: "https://github.com/pytorch/pytorch/pull/100" } as StoredPullRequest],
    now: () => now,
    dayOf: (iso) => iso.slice(0, 10),
    startOfDay: (nowIso, daysAgo) => new Date(Date.parse(`${nowIso.slice(0, 10)}T00:00:00Z`) - daysAgo * 86_400_000).toISOString(),
    ...overrides,
  };
  return { api: createActivityApi(deps), setNow: (iso: string) => { now = iso; }, ledger: () => ledger, appendRaw: (text: string) => { ledger += text; } };
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
  assert.deepEqual(week.days.slice(-2).map((day) => [day.date, day.activeMs, day.reviews, day.preReviews, day.triage]), [["2026-09-09", 60_000, 1, 0, 0], ["2026-09-10", 120_000, 1, 1, 1]]);
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
