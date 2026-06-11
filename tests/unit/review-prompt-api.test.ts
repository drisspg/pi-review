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
  assert.match(focus.prompt, /Focus areas/);
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

  assert.deepEqual(inline, { purpose: "inline-chat", prompt: "Review PR pr. File: src/a.ts. Lines: 10-12. Side: RIGHT. Hunk: @@\n\nAnswer from the visible hunk first and keep it concise. Use tools only if the question cannot be answered from the hunk or asks for broader context.\n\nQuestion: why?" });
  assert.deepEqual(focus, { purpose: "focus-chat", prompt: "Review PR pr. Focus area: src/a.ts:4-6\n\nFocus finding:\nfinding\n\nQuestion: what now?" });
  assert.equal(chat.purpose, "chat");
  assert.match(chat.prompt, /Previous dialogue:\nUser: hi/);
});

test("review prompt API validates mode and required inputs", async () => {
  await assert.rejects(api().build({}), /Expected mode/);
  await assert.rejects(api().build({ mode: "missing" }), /Unknown prompt mode missing/);
  await assert.rejects(api().build({ mode: "main-review", prKey: "pr" }), /Expected files/);
  await assert.rejects(api().build({ mode: "test-pr", prKey: "pr" }), /Expected testIntent/);
  await assert.rejects(api().build({ mode: "focus-chat", prKey: "pr", path: "p", startLine: 1, body: "b", question: "q" }), /Expected focus range/);
});
