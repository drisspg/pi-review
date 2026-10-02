import assert from "node:assert/strict";
import test from "node:test";

import { classifyPullRequestStage, createPytorchWorkflowApi, mentionedIssues, parsePreReviewAssessment, githubSearchUrl, normalizeModules, parsePytorchPrNumber, pytorchQueueQueries, WHY_CLOSED_URL, type PytorchStore, type PytorchWorkflowDeps } from "../../src/pytorch-workflow-api.js";
import type { PytorchIssueSnapshot, PytorchPullSnapshot } from "../../src/types.js";

const NOW = "2026-09-10T12:00:00Z";

function pull(overrides: Partial<PytorchPullSnapshot>): PytorchPullSnapshot {
  return { id: "PR_1", number: 1, title: "t", url: "https://github.com/pytorch/pytorch/pull/1", author: "alice", body: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: NOW, state: "OPEN", isDraft: false, additions: 1, deletions: 0, changedFiles: 1, labels: [], reviewers: ["viewer"], reviewDecision: null, checks: "SUCCESS", viewerThumbsUp: false, linkedIssues: [], ...overrides };
}

function issue(overrides: Partial<PytorchIssueSnapshot>): PytorchIssueSnapshot {
  return { number: 10, title: "bug", url: "https://github.com/pytorch/pytorch/issues/10", author: "bob", createdAt: "2026-09-08T00:00:00Z", updatedAt: NOW, labels: ["triaged", "module: autograd"], assignees: [], comments: 0, ...overrides };
}

type Harness = { deps: PytorchWorkflowDeps; calls: string[]; queries: string[]; stored: () => PytorchStore | null; setNow: (iso: string) => void };

function harness(overrides: Partial<PytorchWorkflowDeps> = {}, initial: PytorchStore | null = null): Harness {
  const calls: string[] = [];
  const queries: string[] = [];
  let stored = initial;
  let now = NOW;
  const deps: PytorchWorkflowDeps = {
    fetchViewerLogin: async () => "viewer",
    searchPullRequests: async (query) => {
      queries.push(query);
      return query.includes("label:triaged")
        ? { total: 3, items: [pull({ number: 1, labels: ["triaged"], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", viewerThumbsUp: true }), pull({ number: 2, labels: ["triaged"], createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z" }), pull({ number: 3, labels: ["triaged"], createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" })] }
        : { total: 1, items: [pull({ number: 4, labels: ["ready for review"], reviewDecision: "CHANGES_REQUESTED" })] };
    },
    searchIssues: async (query) => {
      queries.push(query);
      return { total: 2, items: [issue({ number: 10, createdAt: "2026-08-20T00:00:00Z" }), issue({ number: 11 })] };
    },
    fetchPullRequest: async (ref) => pull({ number: ref.number, labels: ["triaged"] }),
    listModuleLabels: async () => ["module: autograd"],
    addReaction: async (ref, content) => { calls.push(`react ${ref.number} ${content}`); },
    addLabels: async (ref, labels) => { calls.push(`label ${ref.number} ${labels.join(",")}`); },
    addComment: async (ref, body) => { calls.push(`comment ${ref.number} ${body}`); },
    closeIssue: async (ref) => { calls.push(`close ${ref.number}`); },
    convertToDraft: async (ref) => { calls.push(`draft ${ref.number}`); },
    listRecentPullRequests: async () => [],
    listIssueNotifications: async () => [],
    readStore: async () => stored,
    writeStore: async (store) => { stored = store; },
    now: () => now,
    ...overrides,
  };
  return { deps, calls, queries, stored: () => stored, setNow: (iso) => { now = iso; } };
}

test("PR stage follows the lifecycle table, with drafts and terminal states taking precedence over labels", () => {
  const base = { labels: [] as string[], isDraft: false, state: "OPEN" as const, reviewDecision: null };
  const stage = (overrides: Partial<typeof base> & { reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | null; state?: "OPEN" | "MERGED" | "CLOSED" }) => classifyPullRequestStage({ ...base, ...overrides });
  assert.equal(stage({}).stage, "awaiting-triage");
  assert.deepEqual([stage({ labels: ["triaged"] }).stage, stage({ labels: ["triaged"] }).actor], ["pre-review", "reviewers"]);
  assert.deepEqual([stage({ labels: ["triaged", "in progress"] }).stage, stage({ labels: ["triaged", "in progress"] }).actor], ["in-progress", "author"]);
  assert.equal(stage({ labels: ["triaged", "ready for review"] }).stage, "ready-for-review");
  assert.equal(stage({ labels: ["ready for review"], reviewDecision: "APPROVED" }).stage, "accepted");
  assert.equal(stage({ labels: ["ready for review"], isDraft: true }).stage, "draft");
  assert.equal(stage({ labels: ["triaged", "missing actionable issue"] }).stage, "missing-issue");
  assert.equal(stage({ labels: ["ready for review"], state: "MERGED" }).stage, "merged");
  const changes = stage({ labels: ["ready for review"], reviewDecision: "CHANGES_REQUESTED" });
  assert.deepEqual([changes.stage, changes.actor, changes.needsSendBack], ["ready-for-review", "author", true]);
  assert.deepEqual([stage({ labels: ["Stale", "high priority"] }).stale, stage({ labels: ["Stale", "high priority"] }).highPriority], [true, true]);
});

test("queue queries match the maintainer guide's searches, scoped to pytorch/pytorch", () => {
  const queries = pytorchQueueQueries(["module: autograd"]);
  assert.equal(queries.preReview, `repo:pytorch/pytorch is:pr is:open -is:draft review-requested:@me label:triaged -label:"in progress" -label:"ready for review" -label:"missing actionable issue"`);
  assert.equal(queries.review, `repo:pytorch/pytorch is:pr is:open review-requested:@me label:"ready for review" -label:"missing actionable issue"`);
  assert.equal(queries.triage[0].query, `repo:pytorch/pytorch is:issue is:open label:triaged label:"module: autograd" -label:"needs reproduction" -label:"needs research" -label:"needs design" -label:actionable -label:"won't fix"`);
  const url = new URL(githubSearchUrl(queries.triage[0].query));
  assert.equal(url.pathname, "/pytorch/pytorch/issues");
  assert.equal(url.searchParams.get("q"), queries.triage[0].query.replace("repo:pytorch/pytorch ", ""));
});

test("module settings accept only module/oncall labels and dedupe them", () => {
  assert.deepEqual(normalizeModules([" module: autograd ", "oncall: distributed", "module: autograd"]), ["module: autograd", "oncall: distributed"]);
  assert.throws(() => normalizeModules(["triaged"]), /not a module label/);
  assert.throws(() => normalizeModules("module: autograd"), /array/);
});

test("PR references parse from URLs, short refs, and numbers but reject other repos", () => {
  assert.equal(parsePytorchPrNumber("https://github.com/pytorch/pytorch/pull/196508/files"), 196508);
  assert.equal(parsePytorchPrNumber("pytorch/pytorch#12"), 12);
  assert.equal(parsePytorchPrNumber(5), 5);
  assert.throws(() => parsePytorchPrNumber("https://github.com/pytorch/vision/pull/1"), /pytorch\/pytorch/);
});

test("first load awaits one search per queue and module; owed pre-reviews sort most recently updated first, accepted ones last, triage newest first", async () => {
  const h = harness({}, { version: 1, modules: ["module: autograd"], snapshot: null });
  const api = createPytorchWorkflowApi(h.deps);
  const response = await api.queues();
  assert.equal(h.queries.length, 3);
  assert.deepEqual(response.preReview.items.map((pr) => pr.number), [2, 3, 1]);
  assert.equal(response.preReview.items[0].stage.stage, "pre-review");
  assert.equal(response.review.items[0].stage.needsSendBack, true);
  const triage = response.triage[0];
  assert.equal(triage.module, "module: autograd");
  assert.deepEqual(triage.items.map((item) => [item.number, item.ageDays, item.overdue]), [[11, 2, false], [10, 21, true]]);
  assert.equal(response.refreshing, false);
});

test("a fresh snapshot is served without GitHub calls; stale or module changes refresh in the background", async () => {
  const h = harness({}, { version: 1, modules: [], snapshot: null });
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  assert.equal(h.queries.length, 2);
  await api.queues();
  assert.equal(h.queries.length, 2, "fresh snapshot must not re-query");

  await api.setModules({ modules: ["module: autograd"] });
  await api.settle();
  assert.equal(h.queries.length, 5, "module change refetches every queue");
  assert.deepEqual(h.stored()?.snapshot?.modules, ["module: autograd"]);

  h.setNow("2026-09-10T12:06:00Z");
  const stale = await api.queues();
  assert.equal(stale.refreshing, true);
  assert.equal(stale.triage[0].items.length, 2, "stale data stays visible while refreshing");
  await api.settle();
  assert.equal(h.queries.length, 8);
});

test("a failing queue keeps its previous results and reports a warning", async () => {
  let fail = false;
  const h = harness({}, { version: 1, modules: [], snapshot: null });
  const original = h.deps.searchPullRequests;
  h.deps.searchPullRequests = async (query) => {
    if (fail && query.includes("label:triaged")) throw new Error("gh: HTTP 502");
    return original(query);
  };
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  fail = true;
  await api.queues({ refresh: true });
  await api.settle();
  const response = await api.queues();
  assert.equal(response.preReview.items.length, 3);
  assert.deepEqual(response.warnings, ["Could not load pre-review queue: HTTP 502"]);
});

test("accepting a pre-review reacts 👍 and keeps the PR visible as accepted", async () => {
  const h = harness();
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  await api.acceptPreReview({ number: 3 });
  assert.deepEqual(h.calls, ["react 3 +1"]);
  const response = await api.queues();
  assert.deepEqual(response.preReview.items.map((pr) => [pr.number, pr.viewerThumbsUp]), [[2, false], [3, true], [1, true]]);
});

test("declining explains the reason, links the FAQ when closing, and drops the PR from the queue", async () => {
  const h = harness();
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  await assert.rejects(api.declinePreReview({ number: 2, outcome: "close", reason: "  " }), /reason/);
  assert.deepEqual(h.calls, [], "no GitHub writes without a reason");

  await api.declinePreReview({ number: 2, outcome: "close", reason: "Needs a design discussion on the issue." });
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0], /^comment 2 Needs a design discussion/);
  assert.ok(h.calls[0].includes(WHY_CLOSED_URL));
  assert.equal(h.calls[1], "close 2");

  await api.declinePreReview({ number: 3, outcome: "draft", reason: "Please clarify the perf impact." });
  assert.deepEqual(h.calls.slice(2).map((call) => call.split(" ").slice(0, 2).join(" ")), ["comment 3", "draft 3"]);
  const response = await api.queues();
  assert.deepEqual(response.preReview.items.map((pr) => pr.number), [1]);
  assert.equal(response.preReview.total, 1);
});

test("issue triage applies only workflow labels and requires a reason for won't fix", async () => {
  const h = harness({}, { version: 1, modules: ["module: autograd"], snapshot: null });
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  await assert.rejects(api.triageIssue({ number: 10, label: "bug" }), /one of/);
  await assert.rejects(api.triageIssue({ number: 10, label: "won't fix" }), /explain/);
  assert.deepEqual(h.calls, []);

  await api.triageIssue({ number: 10, label: "won't fix", comment: "Low ROI for now." });
  assert.deepEqual(h.calls, ["label 10 won't fix", "comment 10 Low ROI for now."]);
  const response = await api.queues();
  assert.deepEqual(response.triage[0].items.map((item) => item.number), [11]);
  assert.equal(response.triage[0].total, 1);
});

test("sending a changes-requested PR back re-adds in progress and removes it from the review queue", async () => {
  const h = harness();
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  await api.sendBackToInProgress({ number: 4 });
  assert.deepEqual(h.calls, ["label 4 in progress"]);
  assert.equal((await api.queues()).review.items.length, 0);
});

test("PR status reports stage and whether the viewer is a requested reviewer", async () => {
  const h = harness();
  const api = createPytorchWorkflowApi(h.deps);
  const status = await api.prStatus({ prUrl: "https://github.com/pytorch/pytorch/pull/77" });
  assert.equal(status.pr.number, 77);
  assert.equal(status.pr.stage.stage, "pre-review");
  assert.deepEqual([status.viewerIsReviewer, status.viewerIsAuthor], [true, false]);
});

test("description issue mentions surface when GitHub did not parse a closing reference", () => {
  assert.deepEqual(mentionedIssues("Fixes:\n- https://github.com/pytorch/pytorch/issues/92600\nsee #1234 and pytorch/pytorch#99 <!-- #5555 -->", []), [92600, 1234]);
  assert.deepEqual(mentionedIssues("Fixes #1234", [1234]), []);
  assert.deepEqual(mentionedIssues("color: &#1234; a/#555", []), []);
});

test("issue notifications are read live on every response and a failing read degrades to none", async () => {
  let notifications: Array<{ id: string }> = [{ id: "n1" }];
  const h = harness({ listIssueNotifications: async () => notifications as never });
  const api = createPytorchWorkflowApi(h.deps);
  assert.deepEqual((await api.queues()).issueNotifications.map((item) => item.id), ["n1"]);
  notifications = [];
  assert.deepEqual((await api.queues()).issueNotifications, []);
  h.deps.listIssueNotifications = async () => { throw new Error("inbox down"); };
  assert.deepEqual((await createPytorchWorkflowApi(h.deps).queues()).issueNotifications, []);
});

const ASTRA_ANSWER = `PR: #2 t
Recommendation: Close
Why (one line): No pre-condition holds.
Pre-conditions: None established.
Notes:
- Issue is not actionable.
- Author lacks write access.
Suggested comment (only if not Accept):
\`\`\`comment
Please agree the scope on the issue first.
\`\`\``;

test("pre-review answers parse into recommendation, reason, notes, and the suggested comment", () => {
  assert.deepEqual(parsePreReviewAssessment(ASTRA_ANSWER), { recommendation: "close", why: "No pre-condition holds.", preconditions: "None established.", notes: ["Issue is not actionable.", "Author lacks write access."], comment: "Please agree the scope on the issue first." });
  assert.equal(parsePreReviewAssessment("1. clear\n**Recommendation: Back to draft**").recommendation, "draft");
  assert.equal(parsePreReviewAssessment("Recommendation: Accept").comment, null);
  assert.throws(() => parsePreReviewAssessment("Looks fine to me"), /Recommendation/);
});

test("saved assessments persist, attach to queue rows, and go outdated when the PR changes", async () => {
  const h = harness();
  const api = createPytorchWorkflowApi(h.deps);
  await api.queues();
  await assert.rejects(api.saveAssessment({ number: 2, markdown: "no verdict" }), /Recommendation/);
  const { assessment } = await api.saveAssessment({ number: 2, markdown: ASTRA_ANSWER, source: "Astra (high)" });
  assert.deepEqual([assessment.recommendation, assessment.source, assessment.prUpdatedAt], ["close", "Astra (high)", "2026-09-09T00:00:00Z"]);
  assert.equal(h.stored()?.assessments?.["2"]?.why, "No pre-condition holds.");
  assert.deepEqual(h.calls, [], "saving an assessment never writes to GitHub");

  const rows = (await api.queues()).preReview.items;
  assert.deepEqual([rows[0].number, rows[0].assessment?.recommendation, rows[0].assessment?.outdated], [2, "close", false]);
  assert.equal(rows[1].assessment, null);

  await api.saveAssessment({ number: 3, markdown: "Recommendation: Accept", prUpdatedAt: "2026-09-01T00:00:00Z" });
  assert.equal((await api.queues()).preReview.items.find((pr) => pr.number === 3)?.assessment?.outdated, true);
  assert.equal((await createPytorchWorkflowApi(h.deps).queues()).preReview.items[0].assessment?.recommendation, "close", "assessments survive a restart");
});
