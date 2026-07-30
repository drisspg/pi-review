import assert from "node:assert/strict";
import test from "node:test";

import { createPiTerminalDraftApi } from "../../src/pi-terminal-draft-api.js";
import type { DraftReview } from "../../src/types.js";

const context = {
  headSha: "abcdef1234567",
  files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -4,1 +4,2 @@\n old\n+new" }],
};

test("creates and broadcasts a validated terminal review draft", async () => {
  const calls: unknown[] = [];
  const draftReview: DraftReview = { prKey: "github.com/org/repo#1", headSha: context.headSha, event: "COMMENT", body: "", comments: [{ id: "draft-1", path: "src/a.ts", line: 5, side: "RIGHT", body: "Please cover this case." }], updatedAt: "now" };
  const api = createPiTerminalDraftApi({
    contextForPr: () => context,
    async appendDraftReviewComment(prKey, headSha, comment) {
      calls.push({ prKey, headSha, comment });
      return { draftReview, comment: draftReview.comments[0], created: true };
    },
    async notifyDraftReview(prKey, review) { calls.push({ prKey, review }); },
  });

  const result = await api.add({ prKey: draftReview.prKey, headSha: context.headSha, path: "src/a.ts", line: 5, side: "RIGHT", body: "Please cover this case." });

  assert.equal(result.created, true);
  assert.deepEqual(calls, [
    { prKey: draftReview.prKey, headSha: context.headSha, comment: { path: "src/a.ts", line: 5, side: "RIGHT", body: "Please cover this case." } },
    { prKey: draftReview.prKey, review: draftReview },
  ]);
});

test("rejects stale or unreviewable terminal comment targets", async () => {
  const api = createPiTerminalDraftApi({
    contextForPr: () => context,
    async appendDraftReviewComment() { throw new Error("should not append"); },
    async notifyDraftReview() {},
  });

  await assert.rejects(() => api.add({ prKey: "github.com/org/repo#1", headSha: "deadbee", path: "src/a.ts", line: 5, body: "note" }), /pull request changed/i);
  await assert.rejects(() => api.add({ prKey: "github.com/org/repo#1", headSha: context.headSha, path: "src/a.ts", line: 500, body: "note" }), /not reviewable/i);
});
