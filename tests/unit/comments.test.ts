import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffAnnotationIndex, diffAnnotationTargetKey } from "../../web/src/lib/comments.js";
import type { DraftComment, FocusArea, PullReviewComment, Thread } from "../../web/src/types.js";

const lineKey = (line: number) => diffAnnotationTargetKey({ path: "src/a.ts", side: "RIGHT", line });

function reviewComment(overrides: Partial<PullReviewComment>): PullReviewComment {
  return { id: 1, path: "src/a.ts", line: 10, side: "RIGHT", body: "comment", html_url: "comment", ...overrides };
}

test("diff annotation index groups comments and indexes row annotations", () => {
  const comments = [reviewComment({}), reviewComment({ id: 2, in_reply_to_id: 1, body: "reply" })];
  const drafts: DraftComment[] = [{ id: "draft", path: "src/a.ts", line: 10, side: "RIGHT", body: "draft" }];
  const focusAreas: FocusArea[] = [{ id: "focus", path: "src/a.ts", startLine: 10, endLine: 12, title: "Focus", body: "body" }];
  const thread: Thread = { key: "thread", target: { path: "src/a.ts", startLine: 9, line: 11, side: "RIGHT", hunk: "" }, collapsed: false, draft: "", messages: [] };

  const index = buildDiffAnnotationIndex(comments, drafts, { thread }, focusAreas);

  assert.deepEqual(index.commentThreadsByFile.get("src/a.ts")?.map((group) => group.map((comment) => comment.id)), [[1, 2]]);
  assert.deepEqual(index.commentThreadsByTarget.get(lineKey(10))?.map((group) => group.map((comment) => comment.id)), [[1, 2]]);
  assert.deepEqual(index.draftsByTarget.get(lineKey(10))?.map((draft) => draft.id), ["draft"]);
  assert.deepEqual(index.focusAreasByTarget.get(lineKey(10))?.map((area) => area.id), ["focus"]);
  assert.equal(index.threadsByTarget.get(lineKey(11)), thread);
  assert.deepEqual([9, 10, 11, 12].map((line) => index.openThreadRangeTargets.has(lineKey(line))), [true, true, true, false]);
});

test("diff annotation index excludes collapsed thread ranges", () => {
  const thread: Thread = { key: "thread", target: { path: "src/a.ts", startLine: 9, line: 11, side: "RIGHT", hunk: "" }, collapsed: true, draft: "", messages: [] };

  const index = buildDiffAnnotationIndex([], [], { thread }, []);

  assert.equal(index.threadsByTarget.get(lineKey(11)), thread);
  assert.equal(index.openThreadRangeTargets.size, 0);
});
