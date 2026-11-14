import assert from "node:assert/strict";
import test from "node:test";

import { buildStackView, createStackApi, memberStatus, parseStack, splitStackBlock, type StackMemberState } from "../../src/stack-api.js";

const SP_BODY = "Stacked PRs:\n * #2743\n * #2741\n * __->__#3044\n * #3062\n * #2733\n\n--- --- ---\n\n## Human Note\n\nSee #2732 for context.";
const GHSTACK_BODY = "Stack from [ghstack](https://github.com/ezyang/ghstack) (oldest at bottom):\n* #201330\n* __->__ #201329\n* #201328\n\nFixes #9";

function member(overrides: Partial<StackMemberState>): StackMemberState {
  return { number: 1, title: "t", url: "u", state: "OPEN", landedLabel: false, isDraft: false, reviewDecision: null, headSha: "h1", additions: 1, deletions: 0, viewerReview: null, ...overrides };
}

test("sp/stack-pr and ghstack blocks parse bottom-to-top with the current PR marked", () => {
  assert.deepEqual(parseStack(SP_BODY), { format: "sp", members: [2733, 3062, 3044, 2741, 2743], current: 3044 });
  assert.deepEqual(parseStack(GHSTACK_BODY), { format: "ghstack", members: [201328, 201329, 201330], current: 201329 });
  assert.deepEqual(parseStack("Stacked PRs:\n* https://github.com/o/r/pull/5\n* -> https://github.com/o/r/pull/6")?.members, [6, 5]);
  assert.equal(parseStack("Fixes #12 and relates to #13"), null, "plain issue references are not a stack");
  assert.equal(parseStack("Stacked PRs:\n * __->__#1\n\nbody"), null, "a single PR is not a stack");
});

test("splitting the stack block leaves only the author's description", () => {
  assert.deepEqual(splitStackBlock(SP_BODY), { stack: parseStack(SP_BODY), description: "## Human Note\n\nSee #2732 for context." });
  assert.equal(splitStackBlock(GHSTACK_BODY).description, "Fixes #9");
  assert.equal(splitStackBlock("Intro line\r\n\r\nStacked PRs:\r\n * #2\r\n * __->__#1\r\n\r\n---\r\n\r\nBody").description, "Intro line\n\nBody", "text before the block and plain --- separators are handled");
  assert.equal(splitStackBlock("Stacked PRs:\n * #1\n * #2\n").description, "", "a body that is only a stack has no description");
  assert.deepEqual(splitStackBlock("Fixes #12\n\n---\n\nmore"), { stack: null, description: "Fixes #12\n\n---\n\nmore" }, "no stack means no change");
});

test("member status distinguishes landed (incl. merge-bot label), closed, draft, and review decision", () => {
  assert.equal(memberStatus(member({ state: "MERGED" })), "landed");
  assert.equal(memberStatus(member({ state: "CLOSED", landedLabel: true })), "landed");
  assert.equal(memberStatus(member({ state: "CLOSED" })), "closed");
  assert.equal(memberStatus(member({ isDraft: true })), "draft");
  assert.equal(memberStatus(member({ reviewDecision: "APPROVED" })), "approved");
  assert.equal(memberStatus(member({ reviewDecision: "CHANGES_REQUESTED" })), "changes-requested");
  assert.equal(memberStatus(member({})), "needs-review");
});

test("the view answers: where am I, what lands next, and is my review current", () => {
  const parsed = parseStack(SP_BODY)!;
  const view = buildStackView(parsed, "o/r", [
    member({ number: 2733, state: "MERGED" }),
    member({ number: 3062, reviewDecision: "APPROVED", headSha: "a", viewerReview: { state: "APPROVED", commitSha: "a", submittedAt: "x" } }),
    member({ number: 3044, headSha: "new", viewerReview: { state: "COMMENTED", commitSha: "old", submittedAt: "x" } }),
    member({ number: 2741 }),
    member({ number: 2743, isDraft: true }),
  ], 3044);
  assert.deepEqual(view.members.map((entry) => [entry.number, entry.status, entry.isCurrent, entry.viewerReview?.freshness ?? null]), [
    [2733, "landed", false, null], [3062, "approved", false, "current"], [3044, "needs-review", true, "stale"], [2741, "needs-review", false, null], [2743, "draft", false, null],
  ]);
  assert.equal(view.currentPosition, 2);
  assert.equal(view.nextToLand, 3062);
  assert.deepEqual(view.counts, { total: 5, landed: 1, reviewedByViewer: 1, approved: 1 });
});

test("positions skip members missing from the fetch so the current PR keeps its place", () => {
  const view = buildStackView(parseStack(SP_BODY)!, "o/r", [member({ number: 3062 }), member({ number: 3044 }), member({ number: 2743 })], 3044);
  assert.deepEqual(view.members.map((entry) => [entry.number, entry.position]), [[3062, 0], [3044, 1], [2743, 2]]);
  assert.equal(view.currentPosition, 1);
});

test("stack lookups cache member state briefly, refresh on demand, and return null without a stack", async () => {
  let fetches = 0;
  let now = 0;
  const api = createStackApi({
    readBody: async (ref) => ref.number === 3044 ? SP_BODY : "no stack here",
    fetchMembers: async (_repo, numbers) => { fetches += 1; return numbers.map((number) => member({ number })); },
    now: () => now,
  });
  const url = "https://github.com/o/r/pull/3044";
  assert.equal((await api.stack({ prUrl: url })).stack?.members.length, 5);
  await api.stack({ prUrl: url });
  assert.equal(fetches, 1);
  await api.stack({ prUrl: url, refresh: true });
  assert.equal(fetches, 2);
  now = 3 * 60 * 1000;
  await api.stack({ prUrl: url });
  assert.equal(fetches, 3);
  assert.deepEqual(await api.stack({ prUrl: "https://github.com/o/r/pull/1" }), { stack: null });
  await assert.rejects(api.stack({ prUrl: "o/r#1" }), /Expected prUrl/);
});
