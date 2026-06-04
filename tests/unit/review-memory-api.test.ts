import assert from "node:assert/strict";
import test from "node:test";

import { createReviewMemoryApi, reviewMemoryCaptureRecord, reviewSubmitMemoryRecord } from "../../src/review-memory-api.js";
import type { PullRequestReviewData, ReviewMemoryRecord } from "../../src/types.js";

const memoryRecord: ReviewMemoryRecord = {
  id: "memory-1",
  prKey: "github.com/pytorch/pytorch#1",
  headSha: "head",
  event: "COMMENT",
  body: "body",
  comments: [],
  createdAt: "2026-06-04T00:00:00.000Z",
};

function fakeDeps() {
  const savedProfiles: string[] = [];
  const savedMemory: Array<Omit<ReviewMemoryRecord, "id" | "createdAt">> = [];
  return {
    savedProfiles,
    savedMemory,
    deps: {
      async askPi(prKey: string, prompt: string, purpose?: string) {
        assert.equal(prKey, "review-memory");
        assert.equal(purpose, "review-memory-distill");
        assert.match(prompt, /Existing profile:\nold profile/);
        assert.match(prompt, /Raw review evidence:\nraw evidence/);
        return "new profile";
      },
      async currentReviewMemoryDistillationSource() {
        return "raw evidence";
      },
      async currentReviewMemoryPrompt() {
        return "prompt";
      },
      async currentReviewProfile() {
        return { text: "old profile", sourceRecordCount: 1, updatedAt: "then" };
      },
      async listReviewMemoryRecords(limit?: number) {
        assert.equal(limit, 200);
        return [memoryRecord];
      },
      async reviewMemoryStats() {
        return { recordCount: 1, inlineCommentCount: 0, prCount: 1, latestCreatedAt: "then", profileUpdatedAt: "then", profileSourceRecordCount: 1 };
      },
      async saveReviewMemory(record: Omit<ReviewMemoryRecord, "id" | "createdAt">) {
        savedMemory.push(record);
        return { ...record, id: "saved", createdAt: "now" };
      },
      async saveReviewProfile(text: string) {
        savedProfiles.push(text);
        return { text, sourceRecordCount: 1, updatedAt: "now" };
      },
    },
  };
}

test("review memory status clamps requested record limit", async () => {
  const { deps } = fakeDeps();

  assert.deepEqual(await createReviewMemoryApi(deps).status("999"), {
    prompt: "prompt",
    profile: { text: "old profile", sourceRecordCount: 1, updatedAt: "then" },
    records: [memoryRecord],
    stats: { recordCount: 1, inlineCommentCount: 0, prCount: 1, latestCreatedAt: "then", profileUpdatedAt: "then", profileSourceRecordCount: 1 },
  });
});

test("review memory capture validates and normalizes submitted comments", async () => {
  const record = reviewMemoryCaptureRecord({ prKey: "pr", headSha: "head", event: "COMMENT", body: "  overall  ", comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "  inline  " }] });

  assert.equal(record.body, "overall");
  assert.deepEqual(record.comments, [{ path: "a.ts", line: 3, startLine: null, side: "RIGHT", body: "inline" }]);
});

test("review memory API capture delegates persisted record", async () => {
  const { deps, savedMemory } = fakeDeps();

  assert.equal((await createReviewMemoryApi(deps).capture({ prKey: "pr", headSha: "head", event: "APPROVE", body: "ok", comments: [] })).memory.id, "saved");
  assert.equal(savedMemory[0]?.event, "APPROVE");
});

test("review memory API distills profile via Pi and saves answer", async () => {
  const { deps, savedProfiles } = fakeDeps();

  assert.deepEqual(await createReviewMemoryApi(deps).distill(), { profile: "new profile" });
  assert.deepEqual(savedProfiles, ["new profile"]);
});

test("review submit memory record derives commented-file change set", () => {
  const reviewData = {
    raw: { title: "PR", html_url: "https://example.test/pr", number: 1, base: { repo: { full_name: "pytorch/pytorch" } } },
    files: [
      { filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ a" },
      { filename: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ b" },
    ],
  } as PullRequestReviewData;

  const record = reviewSubmitMemoryRecord({ event: "REQUEST_CHANGES", headSha: "head", body: " body ", comments: [{ path: "a.ts", line: 1, side: "RIGHT", body: "issue" }] }, reviewData, "pr");

  assert.equal(record.event, "REQUEST_CHANGES");
  assert.equal(record.body, "body");
  assert.deepEqual(record.changeSet?.files.map((file) => file.path), ["a.ts"]);
});
