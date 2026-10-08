import assert from "node:assert/strict";
import test from "node:test";

import { createPiTerminalDraftApi } from "../../src/pi-terminal-draft-api.js";
import type { DraftReview } from "../../src/types.js";

const context = {
  headSha: "abcdef1234567",
  files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ -4,1 +4,2 @@\n old\n+new" }],
};

const unusedEdits = {
  async getDraftReview() { return null; },
  async updateDraftReviewComment(): Promise<never> { throw new Error("unused"); },
  async deleteDraftReviewComment(): Promise<never> { throw new Error("unused"); },
};

test("creates and broadcasts a validated terminal review draft", async () => {
  const calls: unknown[] = [];
  const draftReview: DraftReview = { prKey: "github.com/org/repo#1", headSha: context.headSha, event: "COMMENT", body: "", comments: [{ id: "draft-1", path: "src/a.ts", line: 5, side: "RIGHT", body: "Please cover this case." }], updatedAt: "now" };
  const api = createPiTerminalDraftApi({
    ...unusedEdits,
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
    ...unusedEdits,
    contextForPr: () => context,
    async appendDraftReviewComment() { throw new Error("should not append"); },
    async notifyDraftReview() {},
  });

  await assert.rejects(() => api.add({ prKey: "github.com/org/repo#1", headSha: "deadbee", path: "src/a.ts", line: 5, body: "note" }), /pull request changed/i);
  await assert.rejects(() => api.add({ prKey: "github.com/org/repo#1", headSha: context.headSha, path: "src/a.ts", line: 500, body: "note" }), /not reviewable/i);
});

test("edits and deletes drafts by id and broadcasts the updated review to open pages", async () => {
  const broadcasts: DraftReview[] = [];
  let comments: DraftReview["comments"] = [{ id: "pi-1", path: "src/a.ts", line: 5, side: "RIGHT", body: "old" }];
  const review = (): DraftReview => ({ prKey: "github.com/org/repo#1", headSha: context.headSha, event: "COMMENT", body: "", comments, updatedAt: "now" });
  const api = createPiTerminalDraftApi({
    contextForPr: () => context,
    async appendDraftReviewComment() { throw new Error("unused"); },
    async getDraftReview() { return review(); },
    async updateDraftReviewComment(_prKey, id, body) {
      comments = comments.map((comment) => comment.id === id ? { ...comment, body } : comment);
      return { draftReview: review(), comment: comments[0] };
    },
    async deleteDraftReviewComment(_prKey, id) {
      const comment = comments.find((candidate) => candidate.id === id)!;
      comments = comments.filter((candidate) => candidate.id !== id);
      return { draftReview: review(), comment };
    },
    async notifyDraftReview(_prKey, draftReview) { broadcasts.push(draftReview); },
  });

  assert.deepEqual((await api.list({ prKey: "github.com/org/repo#1" })).comments.map((comment) => comment.id), ["pi-1"]);
  await api.edit({ prKey: "github.com/org/repo#1", id: "pi-1", body: "new" });
  await api.remove({ prKey: "github.com/org/repo#1", id: "pi-1" });
  assert.deepEqual(broadcasts.map((draft) => draft.comments.map((comment) => comment.body)), [["new"], []]);
  await assert.rejects(api.edit({ prKey: "github.com/org/repo#1", id: "pi-1" }), /Expected body/);
});
