import assert from "node:assert/strict";
import test from "node:test";

import { createPreReviewChat, preReviewChatPrompt, type ChatTurn, type PreReviewChatDeps } from "../../src/pre-review-chat.js";
import type { PytorchPreReviewAssessment, PytorchPreReviewEvidence } from "../../src/types.js";

const evidence: PytorchPreReviewEvidence = { number: 7, title: "Fix div by zero", url: "", author: "alice", authorPermission: "read", body: "Fixes #9", labels: ["triaged"], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", additions: 5, deletions: 1, changedFiles: 1, files: [{ path: "a.py", additions: 5, deletions: 1, patch: "@@ -1 +1 @@\n-x\n+y" }], reviews: [], comments: [], linkedIssues: [{ number: 9, title: "bug", state: "CLOSED", labels: [], body: "", comments: [] }] };
const assessment: PytorchPreReviewAssessment = { number: 7, recommendation: "close", why: "Linked issue already fixed.", preconditions: "None.", notes: ["eellison: too large"], comment: "Please discuss on the issue.", source: "Astra", assessedAt: "2026-09-03T00:00:00Z", prUpdatedAt: "2026-09-02T00:00:00Z" };

function harness(overrides: Partial<PreReviewChatDeps> = {}) {
  const threads = new Map<number, ChatTurn[]>();
  const prompts: string[] = [];
  let evidenceReads = 0;
  let now = Date.parse("2026-09-10T00:00:00Z");
  const deps: PreReviewChatDeps = {
    gatherEvidence: async () => { evidenceReads += 1; return evidence; },
    runModel: async (prompt) => { prompts.push(prompt); return `answer ${prompts.length}`; },
    readAssessment: async () => assessment,
    readThread: async (number) => threads.get(number) ?? [],
    writeThread: async (number, turns) => { threads.set(number, turns); },
    now: () => new Date(now).toISOString(),
    ...overrides,
  };
  return { chat: createPreReviewChat(deps), prompts, threads, evidenceReads: () => evidenceReads, advance: (ms: number) => { now += ms; } };
}

test("a chat turn grounds the model in the saved verdict, evidence, and thread, then persists both turns", async () => {
  const h = harness();
  const first = await h.chat.ask({ number: 7, question: "Why close?" });
  assert.equal(first.answer, "answer 1");
  assert.deepEqual(first.thread.map((turn) => [turn.role, turn.text]), [["user", "Why close?"], ["assistant", "answer 1"]]);
  assert.match(h.prompts[0], /Astra recommended: Close\nWhy: Linked issue already fixed\./);
  assert.match(h.prompts[0], /#9 bug \(CLOSED/);
  assert.match(h.prompts[0], /```diff\n@@ -1 \+1 @@/);
  assert.match(h.prompts[0], /\(this is the first message\)\n\nMaintainer: Why close\?$/);

  await h.chat.ask({ number: 7, question: "But the author says #9 regressed again" });
  assert.match(h.prompts[1], /Maintainer: Why close\?\n\nYou: answer 1\n\nMaintainer: But the author says #9 regressed again$/);
  assert.equal((await h.chat.thread({ number: 7 })).thread.length, 4);
  assert.equal(h.evidenceReads(), 1, "evidence is reused within its TTL");
  h.advance(11 * 60 * 1000);
  await h.chat.ask({ number: 7, question: "again?" });
  assert.equal(h.evidenceReads(), 2);
  assert.deepEqual((await h.chat.clear({ number: 7 })).thread, []);
  assert.deepEqual(h.threads.get(7), []);
});

test("bad input, overlapping turns, and model failures leave the thread unchanged", async () => {
  let release: (() => void) | null = null;
  const h = harness({ runModel: () => new Promise((resolve) => { release = () => resolve("late"); }) });
  await assert.rejects(h.chat.ask({ number: 7, question: "  " }), /question/);
  await assert.rejects(h.chat.ask({ number: 0, question: "x" }), /positive integer/);
  const pending = h.chat.ask({ number: 7, question: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(h.chat.ask({ number: 7, question: "second" }), /Already answering/);
  release!();
  await pending;

  const failing = harness({ runModel: async () => { throw new Error("model exited 1"); } });
  await assert.rejects(failing.chat.ask({ number: 7, question: "why?" }), /model exited/);
  assert.equal(failing.threads.has(7), false);
});

test("the prompt asks for a verdict block only when the recommendation changes, and works without a saved verdict", () => {
  const prompt = preReviewChatPrompt(evidence, null, [], "quick review please");
  assert.match(prompt, /No saved pre-review suggestion yet\./);
  assert.match(prompt, /If, and only if, your recommendation changes/);
  assert.match(prompt, /You have no tools/);
});
