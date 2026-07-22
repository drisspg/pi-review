import assert from "node:assert/strict";
import test from "node:test";

import { createDraftReviewApi } from "../../src/draft-review-api.js";
import type { DraftReview } from "../../src/types.js";

function fakeDeps() {
  const saved: DraftReview[] = [];
  return {
    saved,
    deps: {
      async getDraftReview(prKey: string) {
        return saved.find((review) => review.prKey === prKey) ?? null;
      },
      now: () => "2026-07-13T21:30:00.000Z",
      async saveDraftReview(review: DraftReview) {
        saved.push(review);
        return review;
      },
    },
  };
}

test("draft review API validates and saves review drafts", async () => {
  const { deps, saved } = fakeDeps();
  const response = await createDraftReviewApi(deps).save({
    prKey: "github.com/o/r#1",
    headSha: "head",
    event: "REQUEST_CHANGES",
    body: "overall",
    comments: [{ id: "draft-1", path: "a.ts", line: 12, startLine: 10, side: "RIGHT", body: "local note" }],
  });

  assert.deepEqual(response.draftReview, {
    prKey: "github.com/o/r#1",
    headSha: "head",
    event: "REQUEST_CHANGES",
    body: "overall",
    comments: [{ id: "draft-1", path: "a.ts", line: 12, startLine: 10, side: "RIGHT", body: "local note" }],
    updatedAt: "2026-07-13T21:30:00.000Z",
  });
  assert.deepEqual(saved, [response.draftReview]);
});

test("draft review API gets the current PR draft", async () => {
  const { deps, saved } = fakeDeps();
  saved.push({ prKey: "github.com/o/r#1", headSha: "head", event: "COMMENT", body: "", comments: [], updatedAt: "now" });

  assert.deepEqual(await createDraftReviewApi(deps).get({ prKey: "github.com/o/r#1" }), { draftReview: saved[0] });
  assert.deepEqual(await createDraftReviewApi(deps).get({ prKey: "github.com/o/r#2" }), { draftReview: null });
});

test("draft review API rejects malformed drafts", async () => {
  const api = createDraftReviewApi(fakeDeps().deps);

  await assert.rejects(api.get({}), /Expected prKey/);
  await assert.rejects(api.save({ prKey: "pr", headSha: "head", event: "BAD", body: "", comments: [] }), /Expected draft review payload/);
  await assert.rejects(api.save({ prKey: "pr", headSha: "head", event: "COMMENT", body: "", comments: [{ id: "x" }] }), /Expected draft comment fields/);
});
