import assert from "node:assert/strict";
import test from "node:test";

import { createCheckoutPruneApi, pruneStatus, type CheckoutPruneDeps, type PrunePrState } from "../../src/checkout-prune-api.js";
import type { PullRequestRef } from "../../src/types.js";

const ref = (repo: string, number: number): PullRequestRef => ({ host: "github.com", owner: repo.split("/")[0], repo: repo.split("/")[1], number });
const key = (repo: string, number: number) => `github.com/${repo}#${number}`;

function harness(states: Record<string, PrunePrState>, overrides: Partial<CheckoutPruneDeps> = {}) {
  const deleted: string[] = [];
  const preservedFor: string[] = [];
  const checkouts = [["pytorch/pytorch", 1], ["pytorch/pytorch", 2], ["o/r", 3], ["o/r", 4], ["o/r", 5]] as const;
  const deps: CheckoutPruneDeps = {
    listLocalCheckouts: async () => checkouts.map(([repo, number]) => ({ prKey: key(repo, number), url: `https://github.com/${repo}/pull/${number}`, title: `PR ${number}`, ref: ref(repo, number) })),
    fetchPrStates: async () => new Map(Object.entries(states)),
    hasLiveTerminal: () => false,
    preservePublishedRevisions: async (target) => { preservedFor.push(`${target.repo}#${target.number}`); return { preserved: 1, unpublished: [] }; },
    deleteCheckout: async (url) => { deleted.push(url); },
    ...overrides,
  };
  return { api: createCheckoutPruneApi(deps), deleted, preservedFor };
}

test("landed means merged, or closed with the merge bot's Merged label; plain closed is not landed", () => {
  assert.equal(pruneStatus({ state: "MERGED", landedLabel: false }), "merged");
  assert.equal(pruneStatus({ state: "CLOSED", landedLabel: true }), "landed");
  assert.equal(pruneStatus({ state: "CLOSED", landedLabel: false }), "closed");
  assert.equal(pruneStatus({ state: "OPEN", landedLabel: false }), "open");
  assert.equal(pruneStatus(undefined), "unknown");
});

const STATES: Record<string, PrunePrState> = {
  [key("pytorch/pytorch", 1)]: { state: "CLOSED", landedLabel: true },
  [key("pytorch/pytorch", 2)]: { state: "CLOSED", landedLabel: false },
  [key("o/r", 3)]: { state: "MERGED", landedLabel: false },
  [key("o/r", 4)]: { state: "OPEN", landedLabel: false },
};

test("preview classifies every local checkout and flags live terminals", async () => {
  const h = harness(STATES, { hasLiveTerminal: (prKey) => prKey === key("o/r", 3) });
  const { candidates } = await h.api.preview();
  assert.deepEqual(candidates.map((candidate) => [candidate.prKey.replace("github.com/", ""), candidate.status, candidate.blocked != null]), [
    ["pytorch/pytorch#1", "landed", false], ["pytorch/pytorch#2", "closed", false], ["o/r#3", "merged", true], ["o/r#4", "open", false], ["o/r#5", "unknown", false],
  ]);
  assert.deepEqual(h.deleted, [], "preview never deletes");
});

test("prune deletes only landed checkouts by default, preserving revisions first, and skips live terminals", async () => {
  const h = harness(STATES, { hasLiveTerminal: (prKey) => prKey === key("o/r", 3) });
  const result = await h.api.prune({});
  assert.deepEqual(result.deleted, [key("pytorch/pytorch", 1)]);
  assert.deepEqual(h.preservedFor, ["pytorch#1"]);
  assert.deepEqual(result.kept, [{ prKey: key("o/r", 3), reason: "a Pi terminal is open on this PR" }]);
  assert.equal(result.preserved, 1);
});

test("explicit selection may include abandoned closed PRs, but never open ones, and re-checks state at prune time", async () => {
  const h = harness(STATES);
  const result = await h.api.prune({ prKeys: [key("pytorch/pytorch", 2), key("o/r", 4)], includeClosed: true });
  assert.deepEqual(result.deleted, [key("pytorch/pytorch", 2)]);
  assert.deepEqual(result.kept, [{ prKey: key("o/r", 4), reason: "PR is open, not landed" }]);
  const without = harness(STATES);
  assert.deepEqual((await without.api.prune({ prKeys: [key("pytorch/pytorch", 2)] })).deleted, [], "closed requires includeClosed");
});

test("a refused deletion is reported and the rest continue", async () => {
  const h = harness(STATES, { deleteCheckout: async (url) => { if (url.endsWith("/1")) throw new Error("Checkout protected: local commits"); } });
  const result = await h.api.prune({});
  assert.deepEqual(result.deleted, [key("o/r", 3)]);
  assert.deepEqual(result.kept, [{ prKey: key("pytorch/pytorch", 1), reason: "Checkout protected: local commits" }]);
});
