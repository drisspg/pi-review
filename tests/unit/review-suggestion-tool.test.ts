import assert from "node:assert/strict";
import test from "node:test";
import { createReviewDraftTool } from "../../src/review-draft-tool.js";
import { createReviewSuggestionTool, suggestionBody } from "../../src/review-suggestion-tool.js";

const context = { headSha: "head", files: [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ -10,2 +10,3 @@\n-old\n+new\n+next\n context" }] };

/** Use the real comment validator and capture only the private persistence boundary. */
function harness(target?: Parameters<typeof createReviewSuggestionTool>[1]) {
  const saved: Array<{ path: string; line: number | null; startLine?: number | null; side: "RIGHT" | "LEFT"; body: string }> = [];
  const comment = createReviewDraftTool("pr", context, {
    async appendDraftReviewComment(prKey, headSha, input) {
      saved.push(input);
      const comment = { ...input, id: "suggestion" };
      return { created: true, comment, draftReview: { prKey, headSha, event: "COMMENT", body: "", comments: [comment], updatedAt: "now" } };
    },
  });
  const tool = createReviewSuggestionTool(comment, target);
  return { tool, saved, execute: (params: Parameters<typeof tool.execute>[1]) => tool.execute("call", params, undefined, undefined, undefined as never) };
}

test("suggest_change creates a GitHub suggestion on the selected range, without prose or a review verdict", async () => {
  const h = harness({ path: "a.ts", startLine: 10, line: 11, side: "RIGHT" });
  assert.equal(h.tool.name, "suggest_change");
  await h.execute({ code: "  first();\n  second();" });
  assert.deepEqual(h.saved, [{ path: "a.ts", startLine: 10, line: 11, side: "RIGHT", body: "```suggestion\n  first();\n  second();\n```" }]);
  await h.execute({ code: "", line: 12 });
  assert.deepEqual(h.saved[1], { path: "a.ts", line: 12, side: "RIGHT", body: "```suggestion\n\n```" });
});

test("suggestion code preserves indentation, trailing newlines, and embedded fences", () => {
  assert.equal(suggestionBody("  replacement\n"), "```suggestion\n  replacement\n```");
  assert.equal(suggestionBody("line\n\n"), "```suggestion\nline\n\n```");
  assert.equal(suggestionBody("```python\npass\n```"), "````suggestion\n```python\npass\n```\n````");
});

test("suggestions reject deleted-side anchors, invalid ranges, and missing or non-reviewable targets", async () => {
  const deleted = harness({ path: "a.ts", line: 10, side: "LEFT" });
  await assert.rejects(deleted.execute({ code: "replacement" }), /new \(RIGHT\) side/);
  await deleted.execute({ code: "replacement", line: 10 });
  const h = harness({ path: "a.ts", startLine: 10, line: 11, side: "RIGHT" });
  await assert.rejects(h.execute({ code: "replacement", path: "other.ts" }), /Specify.*new-file line/);
  await assert.rejects(h.execute({ code: "replacement", startLine: 12 }), /startLine no greater/);
  await assert.rejects(h.execute({ code: "replacement", line: 0 }), /positive integers/);
  await assert.rejects(h.execute({ code: "replacement", path: "other.ts", line: 10 }), /not a changed file/);
  await assert.rejects(h.execute({ code: "replacement", line: 999 }), /not reviewable/);
  await assert.rejects(harness().execute({ code: "replacement" }), /Specify/);
  await harness().execute({ code: "replacement", path: "a.ts", startLine: 10, line: 11 });
  assert.equal(h.saved.length, 0);
});
