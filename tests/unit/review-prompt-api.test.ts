import assert from "node:assert/strict";
import test from "node:test";

import { createReviewPromptApi } from "../../src/review-prompt-api.js";

const files = [
  {
    additions: 3,
    deletions: 1,
    filename: "src/a.ts",
    patch: "@@ -1 +1 @@\n-old\n+new",
    status: "modified",
  },
];

function api() {
  return createReviewPromptApi({
    async currentReviewMemoryPrompt() {
      return "memory rules";
    },
  });
}

test("review prompt API builds code walk prompts with flow-dag purpose", async () => {
  const result = await api().build({ mode: "code-walk", prKey: "pr", prTitle: "Title", files });

  assert.equal(result.purpose, "flow-dag");
  assert.match(result.prompt, /Create a reviewer-friendly code walk for PR pr/);
  assert.match(result.prompt, /PR title: Title/);
  assert.match(result.prompt, /Status: modified, \+3\/-1/);
});

test("review prompt API injects memory for main and focus review prompts", async () => {
  const main = await api().build({ mode: "main-review", prKey: "pr", previousAiReview: "old review", previousFocusAreas: "old focus", files });
  const focus = await api().build({ mode: "focus-review", prKey: "pr", prTitle: "Title", previousFocusAreas: "old focus", files });

  assert.equal(main.purpose, "main-review");
  assert.match(main.prompt, /Reviewer preference memory:\nmemory rules/);
  assert.match(main.prompt, /Previous full review:\nold review/);
  assert.equal(focus.purpose, "focus-review");
  assert.match(focus.prompt, /Previous focus scan state:\nold focus/);
  assert.match(focus.prompt, /actively try to disprove the concern/);
  assert.match(focus.prompt, /preserves an intentional user override/);
  assert.match(focus.prompt, /Treat clean configuration as the normal contract/);
  assert.match(focus.prompt, /do not recommend forcing a cached build option/);
  assert.match(focus.prompt, /Prefer no findings over a weak finding/);
  assert.match(focus.prompt, /No focus areas found\./);
});

test("review prompt API builds test-pr prompts for CLI-first validation", async () => {
  const result = await api().build({ mode: "test-pr", prKey: "pr", testIntent: "verify the new backend endpoint", gpuRequired: true, files });

  assert.equal(result.purpose, "test-pr");
  assert.match(result.prompt, /Test PR pr from the command line/);
  assert.match(result.prompt, /verify the new backend endpoint/);
  assert.match(result.prompt, /exercise the backend contract directly first/);
  assert.match(result.prompt, /GPU validation was requested/);
  assert.match(result.prompt, /src\/a\.ts/);
});

test("review prompt API builds chat prompts with typed purposes", async () => {
  const inline = await api().build({ mode: "inline-chat", prKey: "pr", path: "src/a.ts", line: 12, startLine: 10, side: "RIGHT", hunk: "@@", question: "why?" });
  const focus = await api().build({ mode: "focus-chat", prKey: "pr", path: "src/a.ts", startLine: 4, endLine: 6, body: "finding", question: "what now?" });
  const chat = await api().build({ mode: "ai-chat", prKey: "pr", previousDialogue: "User: hi", question: "next?" });

  assert.equal(inline.purpose, "inline-chat");
  assert.match(inline.prompt, /File: src\/a\.ts\. Lines: 10-12\. Side: RIGHT/);
  assert.match(inline.prompt, /draft_review_comment tool/);
  assert.match(inline.prompt, /Question: why\?/);
  assert.equal(focus.purpose, "focus-chat");
  assert.match(focus.prompt, /Focus area: src\/a\.ts:4-6/);
  assert.match(focus.prompt, /draft_review_comment tool/);
  assert.equal(chat.purpose, "chat");
  assert.match(chat.prompt, /Previous dialogue:\nUser: hi/);
  assert.match(chat.prompt, /Do not create drafts for ordinary questions/);
});

test("review prompt API builds copyable review feedback bundles", async () => {
  const result = await api().build({
    mode: "review-feedback",
    prKey: "org/repo#1",
    prTitle: "Improve review panel",
    prUrl: "https://github.com/org/repo/pull/1",
    headSha: "abc123",
    userComments: [{ kind: "Inline review comment", author: "reviewer", location: "src/a.ts:4", state: "unresolved", body: "please handle this edge case", url: "comment-url" }],
    aiComments: [{ role: "user", kind: "chat", text: "what should I test?" }, { role: "pi", title: "Follow-up", kind: "chat", text: "add a regression test" }],
    focusAreas: [{ path: "src/a.ts", startLine: 4, endLine: 6, title: "edge case", body: "src/a.ts:4-6 — check error state", viewed: true }],
    globalFeedback: "Global review says the flow is sound.",
    focusScan: "Focus scan raw output.",
  });

  assert.equal(result.purpose, "review-feedback");
  assert.match(result.prompt, /source-of-truth reviewer feedback/);
  assert.match(result.prompt, /PR: org\/repo#1/);
  assert.match(result.prompt, /Inline review comment · @reviewer · src\/a\.ts:4 · unresolved/);
  assert.match(result.prompt, /please handle this edge case/);
  assert.match(result.prompt, /User · chat\nwhat should I test\?/);
  assert.match(result.prompt, /Pi · Follow-up · chat\nadd a regression test/);
  assert.match(result.prompt, /src\/a\.ts:4-6 — edge case · reviewed/);
  assert.match(result.prompt, /Global review says the flow is sound/);
});

test("review prompt API builds private GitHub draft handoff prompts", async () => {
  const result = await api().build({
    mode: "github-draft-handoff",
    prKey: "org/repo#1",
    prTitle: "Fix edge case",
    prUrl: "https://github.com/org/repo/pull/1",
    headSha: "abc123",
    comments: [{ path: "src/a.ts", startLine: 4, line: 6, body: "handle the empty case", diffHunk: "@@ -4,3 +4,3 @@" }],
  });

  assert.equal(result.purpose, "github-draft-handoff");
  assert.match(result.prompt, /private GitHub review drafts/);
  assert.match(result.prompt, /src\/a\.ts:4-6/);
  assert.match(result.prompt, /handle the empty case/);
  assert.match(result.prompt, /Do not publish, submit, edit, or delete/);
});

test("review prompt API validates mode and required inputs", async () => {
  await assert.rejects(api().build({}), /Expected mode/);
  await assert.rejects(api().build({ mode: "missing" }), /Unknown prompt mode missing/);
  await assert.rejects(api().build({ mode: "main-review", prKey: "pr" }), /Expected files/);
  await assert.rejects(api().build({ mode: "test-pr", prKey: "pr" }), /Expected testIntent/);
  await assert.rejects(api().build({ mode: "focus-chat", prKey: "pr", path: "p", startLine: 1, body: "b", question: "q" }), /Expected focus range/);
  await assert.rejects(api().build({ mode: "review-feedback", prKey: "pr", userComments: [{ body: "" }] }), /Expected userComments\.body/);
  await assert.rejects(api().build({ mode: "review-feedback", prKey: "pr", aiComments: [{ role: "pi" }] }), /Expected aiComments role and text/);
  await assert.rejects(api().build({ mode: "review-feedback", prKey: "pr", focusAreas: [{ path: "p", body: "b", startLine: 1 }] }), /Expected focusAreas location and body/);
  await assert.rejects(api().build({ mode: "github-draft-handoff", prKey: "pr", comments: [] }), /Expected GitHub draft comments/);
  await assert.rejects(api().build({ mode: "github-draft-handoff", prKey: "pr", comments: [{ path: "p", body: "" }] }), /Expected GitHub draft comment location and body/);
});
