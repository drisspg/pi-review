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
  const drafts: DraftReview["comments"] = [{ id: "pi-old", path: "src/example.ts", line: 11, side: "RIGHT", body: "first try" }, { id: "local-7", path: "src/example.ts", line: 10, side: "RIGHT", body: "reviewer note" }];
  const deps: ReviewDraftToolDeps = {
    async getDraftReview(prKey) { return { prKey, headSha: "head", event: "COMMENT", body: "", comments: drafts, updatedAt: "now" }; },
    async updateDraftReviewComment(_prKey, id, body) {
      const index = drafts.findIndex((comment) => comment.id === id);
      if (index < 0) throw new Error(`No review draft ${id} on this PR`);
      drafts[index] = { ...drafts[index], body };
      return { comment: drafts[index] };
    },
    async deleteDraftReviewComment(_prKey, id) {
      const index = drafts.findIndex((comment) => comment.id === id);
      if (index < 0) throw new Error(`No review draft ${id} on this PR`);
      return { comment: drafts.splice(index, 1)[0] };
    },
    async appendDraftReviewComment(prKey, headSha, comment) {
      calls.push({ prKey, headSha, comment });
      const saved = { id: "pi-draft-1", ...comment };
      return { created, comment: saved, draftReview: { prKey, headSha, event: "COMMENT", body: "", comments: [saved], updatedAt: "now" } };
    },
  };
  return { calls, deps, drafts };
}

async function execute(params: Record<string, unknown>, deps = fakeDeps().deps): Promise<ToolResult> {
  return await (createReviewDraftTool("github.com/o/r#1", context, deps).execute as (...args: unknown[]) => Promise<ToolResult>)("call", params);
}

test("review draft tool creates a private multiline draft on a reviewable diff range", async () => {
  const { calls, deps } = fakeDeps();

  const result = await execute({ path: "src/example.ts", startLine: 10, line: 11, side: "RIGHT", body: "  Could this preserve the old behavior?  " }, deps);

  assert.deepEqual(calls, [{ prKey: "github.com/o/r#1", headSha: "head", comment: { path: "src/example.ts", startLine: 10, line: 11, side: "RIGHT", body: "Could this preserve the old behavior?" } }]);
  assert.equal(result.details.created, true);
  assert.match(result.content[0].text, /Created private editable draft pi-draft-1 at src\/example\.ts:10-11/);
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

test("the same tool lists, edits in place, and deletes drafts instead of creating duplicates", async () => {
  const fake = fakeDeps();
  const listed = await execute({ action: "list" }, fake.deps);
  assert.match(listed.content[0].text, /pi-old · src\/example\.ts:11 · by Pi: first try/);
  assert.match(listed.content[0].text, /local-7 · src\/example\.ts:10 · by reviewer: reviewer note/);

  const edited = await execute({ action: "edit", id: "pi-old", body: "zeros_and_scatter(shape, indices, grad)" }, fake.deps);
  assert.match(edited.content[0].text, /Updated private review draft pi-old at src\/example\.ts:11 in place/);
  assert.equal(fake.drafts[0].body, "zeros_and_scatter(shape, indices, grad)");

  await execute({ action: "delete", id: "local-7" }, fake.deps);
  assert.deepEqual(fake.drafts.map((comment) => comment.id), ["pi-old"]);
  assert.deepEqual(fake.calls, [], "no create happened");

  await assert.rejects(execute({ action: "edit", body: "x" }, fake.deps), /needs the draft id/);
  await assert.rejects(execute({ action: "edit", id: "pi-old" }, fake.deps), /complete new body/);
  await assert.rejects(execute({ action: "delete", id: "nope" }, fake.deps), /No review draft nope/);
  await assert.rejects(execute({ body: "missing location" }, fake.deps), /path, line, and body/);
});
