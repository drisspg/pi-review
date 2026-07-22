import assert from "node:assert/strict";
import test from "node:test";

import { createReviewDraftTool, type ReviewDraftToolDeps } from "../../src/review-draft-tool.js";
import type { DraftReview } from "../../src/types.js";

type ToolResult = { content: Array<{ type: string; text: string }>; details: { draftReview: DraftReview; comment: DraftReview["comments"][number]; created: boolean } };

const context = {
  headSha: "head",
  files: [{
    filename: "src/example.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -10,3 +10,3 @@ function example() {\n context\n-old value\n+new value\n context",
  }],
};

function fakeDeps(created = true) {
  const calls: Array<{ prKey: string; headSha: string; comment: Omit<DraftReview["comments"][number], "id"> }> = [];
  const deps: ReviewDraftToolDeps = {
    async appendDraftReviewComment(prKey, headSha, comment) {
      calls.push({ prKey, headSha, comment });
      const saved = { id: "pi-draft-1", ...comment };
      return { created, comment: saved, draftReview: { prKey, headSha, event: "COMMENT", body: "", comments: [saved], updatedAt: "now" } };
    },
  };
  return { calls, deps };
}

async function execute(params: Record<string, unknown>, deps = fakeDeps().deps): Promise<ToolResult> {
  return await (createReviewDraftTool("github.com/o/r#1", context, deps).execute as (...args: unknown[]) => Promise<ToolResult>)("call", params);
}

test("review draft tool creates a private multiline draft on a reviewable diff range", async () => {
  const { calls, deps } = fakeDeps();

  const result = await execute({ path: "src/example.ts", startLine: 10, line: 11, side: "RIGHT", body: "  Could this preserve the old behavior?  " }, deps);

  assert.deepEqual(calls, [{ prKey: "github.com/o/r#1", headSha: "head", comment: { path: "src/example.ts", startLine: 10, line: 11, side: "RIGHT", body: "Could this preserve the old behavior?" } }]);
  assert.equal(result.details.created, true);
  assert.match(result.content[0].text, /Created private editable draft at src\/example\.ts:10-11/);
  assert.match(result.content[0].text, /remains local/);
});

test("review draft tool supports removed lines and reports duplicate drafts", async () => {
  const { deps } = fakeDeps(false);

  const result = await execute({ path: "src/example.ts", line: 11, side: "LEFT", body: "Was removing this intentional?" }, deps);

  assert.equal(result.details.comment.side, "LEFT");
  assert.match(result.content[0].text, /already exists/);
});

test("review draft tool rejects files and lines outside the current diff", async () => {
  await assert.rejects(execute({ path: "src/missing.ts", line: 11, body: "note" }), /not a changed file/);
  await assert.rejects(execute({ path: "src/example.ts", line: 99, body: "note" }), /not reviewable/);
  await assert.rejects(execute({ path: "src/example.ts", startLine: 12, line: 11, body: "note" }), /no greater than line/);
});
