import assert from "node:assert/strict";
import test from "node:test";

import { createStateStore } from "../../src/state.js";
import type { AppState, StoredPullRequest } from "../../src/types.js";

const paths = {
  statePath: "/tmp/pi-review-state/state.json",
  reviewMemoryNotesPath: "/tmp/agent_notes/findings/pi_review_preferences.md",
  reviewProfilePath: "/tmp/agent_notes/findings/pi_review_profile.md",
};

function emptyState(): AppState {
  return { prs: [], fileReviews: [], draftReviews: [], focusScans: [], aiReviews: [], guideReviews: [], overviews: [], reviewMemory: [], reviewProfile: null };
}

function fakeRuntime(initialState?: Partial<AppState>) {
  const files = new Map<string, string>();
  const mkdirs: string[] = [];
  const writes: Array<{ path: string; data: string }> = [];
  const renames: Array<{ oldPath: string; newPath: string }> = [];
  let uuidIndex = 0;
  if (initialState != null) files.set(paths.statePath, JSON.stringify(initialState));
  return {
    files,
    mkdirs,
    writes,
    renames,
    runtime: {
      exists(path: string) {
        return files.has(path);
      },
      async mkdir(path: string) {
        mkdirs.push(path);
      },
      now() {
        return "2026-06-04T00:00:00.000Z";
      },
      async readFile(path: string) {
        const value = files.get(path);
        assert.notEqual(value, undefined, `missing fake file ${path}`);
        return value as string;
      },
      async rename(oldPath: string, newPath: string) {
        const value = files.get(oldPath);
        assert.notEqual(value, undefined, `missing fake temp file ${oldPath}`);
        renames.push({ oldPath, newPath });
        files.set(newPath, value as string);
        files.delete(oldPath);
      },
      uuid() {
        uuidIndex += 1;
        return `uuid-${uuidIndex}`;
      },
      async writeFile(path: string, data: string) {
        writes.push({ path, data });
        files.set(path, data);
      },
    },
  };
}

function pr(overrides: Partial<StoredPullRequest> = {}): StoredPullRequest {
  return {
    key: "github.com/pytorch/pytorch#1",
    ref: { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 },
    url: "https://github.com/pytorch/pytorch/pull/1",
    title: "PR",
    body: null,
    state: "open",
    author: "alice",
    baseSha: "base",
    headSha: "head",
    filesChanged: 1,
    existingCommentCount: 0,
    lastOpenedAt: "2026-06-03T00:00:00.000Z",
    lastReviewedHeadSha: null,
    lastReviewEvent: null,
    reviewDecision: null,
    ...overrides,
  };
}

test("state store returns normalized empty state when no state file exists", async () => {
  const { runtime } = fakeRuntime();

  assert.deepEqual(await createStateStore(runtime, paths).readState(), emptyState());
});

test("state store normalizes partial persisted state", async () => {
  const { runtime } = fakeRuntime({ prs: [pr()] });

  assert.deepEqual(await createStateStore(runtime, paths).readState(), { ...emptyState(), prs: [pr()] });
});

test("upsertPullRequest preserves previous review metadata and writes atomically", async () => {
  const existing = pr({ lastReviewedHeadSha: "reviewed", lastReviewEvent: "COMMENT", reviewDecision: "APPROVED" });
  const incoming = pr({ headSha: "new-head", reviewDecision: null });
  const { runtime, files, mkdirs, writes, renames } = fakeRuntime({ ...emptyState(), prs: [existing] });

  const saved = await createStateStore(runtime, paths).upsertPullRequest(incoming);
  const persisted = JSON.parse(files.get(paths.statePath) ?? "{}") as AppState;

  assert.equal(saved.headSha, "new-head");
  assert.equal(saved.lastReviewedHeadSha, "reviewed");
  assert.equal(saved.lastReviewEvent, "COMMENT");
  assert.equal(saved.reviewDecision, "APPROVED");
  assert.deepEqual(mkdirs, ["/tmp/pi-review-state"]);
  assert.equal(writes[0]?.path, "/tmp/pi-review-state/state.json.uuid-1.tmp");
  assert.deepEqual(renames, [{ oldPath: "/tmp/pi-review-state/state.json.uuid-1.tmp", newPath: paths.statePath }]);
  assert.equal(persisted.prs[0]?.headSha, "new-head");
});

test("state store serializes concurrent mutations without losing updates", async () => {
  const { runtime } = fakeRuntime(emptyState());
  const store = createStateStore(runtime, paths);
  const second = pr({
    key: "github.com/pytorch/pytorch#2",
    ref: { host: "github.com", owner: "pytorch", repo: "pytorch", number: 2 },
    url: "https://github.com/pytorch/pytorch/pull/2",
  });

  await Promise.all([store.upsertPullRequest(pr()), store.upsertPullRequest(second)]);

  assert.deepEqual((await store.listRecentPullRequests()).map((stored) => stored.key).sort(), ["github.com/pytorch/pytorch#1", "github.com/pytorch/pytorch#2"]);
});

test("saveReviewProfile trims text, records source count, and writes profile note", async () => {
  const { runtime, files } = fakeRuntime({ ...emptyState(), reviewMemory: [{ prKey: "a", event: "COMMENT", body: "body", comments: [], id: "memory", createdAt: "then" }] });

  const profile = await createStateStore(runtime, paths).saveReviewProfile("  profile text  ");

  assert.deepEqual(profile, { text: "profile text", sourceRecordCount: 1, updatedAt: "2026-06-04T00:00:00.000Z" });
  assert.equal(files.get(paths.reviewProfilePath), "profile text");
});

test("saveReviewMemory assigns metadata, prepends records, and writes preference prompt", async () => {
  const { runtime, files } = fakeRuntime({ ...emptyState(), reviewMemory: [{ prKey: "old", event: "COMMENT", body: "old", comments: [], id: "old-id", createdAt: "then" }] });

  const saved = await createStateStore(runtime, paths).saveReviewMemory({ prKey: "new", event: "APPROVE", body: "new body", comments: [{ path: "a.ts", line: 10, startLine: null, side: "RIGHT", body: "inline" }], disposition: "archived" });
  const persisted = JSON.parse(files.get(paths.statePath) ?? "{}") as AppState;

  assert.equal(saved.id, "uuid-1");
  assert.equal(saved.createdAt, "2026-06-04T00:00:00.000Z");
  assert.equal(persisted.reviewMemory[0]?.prKey, "new");
  assert.match(files.get(paths.reviewMemoryNotesPath) ?? "", /archived locally/);
  assert.match(files.get(paths.reviewMemoryNotesPath) ?? "", /a\.ts:10: inline/);
});

test("saveDraftReview replaces the PR draft and persists empty drafts", async () => {
  const { runtime } = fakeRuntime(emptyState());
  const store = createStateStore(runtime, paths);
  const first = { prKey: "pr", headSha: "head", event: "COMMENT" as const, body: "overall", comments: [{ id: "1", path: "a.ts", line: 4, side: "RIGHT" as const, body: "note" }], updatedAt: "first" };
  const empty = { ...first, event: "APPROVE" as const, body: "", comments: [], updatedAt: "second" };

  await store.saveDraftReview(first);
  assert.deepEqual(await store.getDraftReview("pr"), first);
  await store.saveDraftReview(empty);

  assert.deepEqual(await store.getDraftReview("pr"), empty);
  assert.equal((await store.readState()).draftReviews.length, 1);
});

test("appendDraftReviewComment preserves review fields, avoids duplicates, and rejects mismatched draft heads", async () => {
  const existing = { prKey: "pr", headSha: "head", event: "REQUEST_CHANGES" as const, body: "overall", comments: [{ id: "local-1", path: "a.ts", line: 4, side: "RIGHT" as const, body: "existing" }], updatedAt: "first" };
  const { runtime } = fakeRuntime({ ...emptyState(), draftReviews: [existing] });
  const store = createStateStore(runtime, paths);
  const input = { path: "b.ts", line: 8, startLine: 7, side: "RIGHT" as const, body: "model draft" };

  const created = await store.appendDraftReviewComment("pr", "head", input);
  const duplicate = await store.appendDraftReviewComment("pr", "head", input);
  await assert.rejects(store.appendDraftReviewComment("pr", "next", { ...input, body: "new head" }), /Stale draft append/);

  assert.equal(created.created, true);
  assert.equal(created.comment.id, "pi-uuid-1");
  assert.equal(created.draftReview.event, "REQUEST_CHANGES");
  assert.equal(created.draftReview.body, "overall");
  assert.deepEqual(created.draftReview.comments.map((comment) => comment.body), ["existing", "model draft"]);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.comment.id, created.comment.id);
  assert.deepEqual(await store.getDraftReview("pr"), created.draftReview);
});

test("clearDraftReview removes only the submitted PR draft", async () => {
  const first = { prKey: "first", headSha: "head", event: "COMMENT" as const, body: "", comments: [], updatedAt: "first" };
  const second = { ...first, prKey: "second" };
  const { runtime } = fakeRuntime({ ...emptyState(), draftReviews: [first, second] });
  const store = createStateStore(runtime, paths);

  await store.clearDraftReview("first");

  assert.equal(await store.getDraftReview("first"), null);
  assert.deepEqual(await store.getDraftReview("second"), second);
});

test("saveOverview preserves generations for the same head", async () => {
  const { runtime } = fakeRuntime(emptyState());
  const store = createStateStore(runtime, paths);

  const first = await store.saveOverview({ prKey: "pr", headSha: "head", answer: "first" });
  const second = await store.saveOverview({ prKey: "pr", headSha: "head", answer: "second" });

  assert.notEqual(second.id, first.id);
  assert.equal((await store.listOverviews("pr")).length, 2);
  assert.equal((await store.listOverviews("pr"))[0].answer, "second");
});

test("saveGuideReview persists step states and drops them when the answer changes", async () => {
  const { runtime } = fakeRuntime(emptyState());
  const store = createStateStore(runtime, paths);

  const saved = await store.saveGuideReview({ prKey: "pr", headSha: "head", answer: "guide", stepStates: { "s1": { reviewed: true, updatedAt: "t1" } } });
  const progressOnly = await store.saveGuideReview({ id: saved.id, prKey: "pr", headSha: "head", answer: "guide" });
  const regenerated = await store.saveGuideReview({ prKey: "pr", headSha: "head", answer: "different" });

  assert.deepEqual(saved.stepStates, { s1: { reviewed: true, updatedAt: "t1" } });
  assert.deepEqual(progressOnly.stepStates, { s1: { reviewed: true, updatedAt: "t1" } });
  assert.equal(regenerated.stepStates, undefined);
});

test("saveGuideReview preserves generations for the same head", async () => {
  const { runtime } = fakeRuntime(emptyState());
  const store = createStateStore(runtime, paths);

  const first = await store.saveGuideReview({ prKey: "pr", headSha: "head", answer: "first" });
  const second = await store.saveGuideReview({ prKey: "pr", headSha: "head", answer: "second" });

  assert.notEqual(second.id, first.id);
  assert.equal((await store.listGuideReviews("pr")).length, 2);
  assert.equal((await store.listGuideReviews("pr"))[0].answer, "second");
});

test("saveFocusScan updates existing records and caps scans per PR", async () => {
  const focusScans = Array.from({ length: 20 }, (_, index) => ({ id: `old-${index}`, prKey: "pr", headSha: "head", answer: `${index}`, areaStates: {}, createdAt: `2026-06-03T00:00:${String(index).padStart(2, "0")}.000Z`, updatedAt: `2026-06-03T00:00:${String(index).padStart(2, "0")}.000Z` }));
  const { runtime } = fakeRuntime({ ...emptyState(), focusScans });
  const store = createStateStore(runtime, paths);

  const saved = await store.saveFocusScan({ prKey: "pr", headSha: "head", answer: "new", areaStates: {} });
  const scans = await store.listFocusScans("pr");

  assert.equal(saved.id, "uuid-1");
  assert.equal(scans.length, 20);
  assert.equal(scans[0]?.answer, "new");
  assert.equal(scans.some((scan) => scan.id === "old-0"), false);
});

test("upsertPullRequest backfills reviewed head from the newest review memory record", async () => {
  const memory = { id: "m1", prKey: pr().key, headSha: "archived-head", event: "COMMENT" as const, body: "", comments: [], createdAt: "then" };
  const { runtime } = fakeRuntime({ ...emptyState(), reviewMemory: [memory] });

  const saved = await createStateStore(runtime, paths).upsertPullRequest(pr({ headSha: "new-head" }));

  assert.equal(saved.lastReviewedHeadSha, "archived-head");
  assert.equal(saved.lastReviewEvent, "COMMENT");
});

for (const kind of ["focus", "guide"] as const) {
  test(`${kind} progress preserves historical identity and generation order`, async () => {
    const { runtime } = fakeRuntime();
    const store = createStateStore(runtime, paths);
    const save = kind === "focus" ? store.saveFocusScan : store.saveGuideReview;
    const provenance = { runId: "run-old", version: 1, model: "test-model", thinkingLevel: "medium" };
    const first = await save({ prKey: "pr", headSha: "old", answer: "old answer", areaStates: {}, createdAt: "2026-01-01", provenance });
    assert.deepEqual(first.provenance, provenance);
    const second = await save({ prKey: "pr", headSha: "new", answer: "new answer", areaStates: {}, createdAt: "2026-02-01" });
    const updated = kind === "focus"
      ? await store.updateFocusScanProgress({ prKey: "pr", id: first.id, areaStates: { a: { viewed: true, collapsed: true, updatedAt: "now" } } })
      : await store.updateGuideReviewProgress({ prKey: "pr", id: first.id, stepStates: { a: { reviewed: true, updatedAt: "now" } } });
    assert.equal(updated.headSha, "old");
    assert.equal(updated.answer, "old answer");
    assert.equal(updated.createdAt, first.createdAt);
    assert.deepEqual(updated.provenance, provenance);
    const records = kind === "focus" ? await store.listFocusScans("pr") : await store.listGuideReviews("pr");
    assert.deepEqual(records.map((record) => record.id), [second.id, first.id]);
    await assert.rejects(save({ ...first, headSha: "new", areaStates: {} }), /immutable/i);
    await assert.rejects(save({ ...first, answer: "changed", areaStates: {} }), /immutable/i);
    await assert.rejects(save({ ...first, provenance: { ...provenance, runId: "another-run" }, areaStates: {} }), /immutable/i);
    await assert.rejects(save({ ...first, createdAt: "later", areaStates: {} }), /immutable/i);
    const before = await store.readState();
    await assert.rejects(kind === "focus"
      ? store.updateFocusScanProgress({ prKey: "other", id: first.id, areaStates: {} })
      : store.updateGuideReviewProgress({ prKey: "other", id: first.id, stepStates: {} }), /not found/i);
    assert.deepEqual(await store.readState(), before);
  });
}

test("draft append checks current HEAD after queued PR and human draft mutations", async () => {
  const { runtime } = fakeRuntime();
  const store = createStateStore(runtime, paths);
  const current = pr({ headSha: "new" });
  const input = { path: "a.ts", line: 1, side: "RIGHT" as const, body: "stale model" };
  const draft = { prKey: current.key, headSha: "new", event: "APPROVE" as const, body: "human", comments: [{ ...input, body: "human", id: "human" }], updatedAt: "human time" };
  const writes = [store.upsertPullRequest(current), store.saveDraftReview(draft)];
  await assert.rejects(store.appendDraftReviewComment(current.key, "old", input), /stale/i);
  await Promise.all(writes);
  assert.deepEqual(await store.getDraftReview(current.key), draft);
  await assert.rejects(store.saveDraftReview({ ...draft, headSha: "old", body: "delayed autosave" }), /Stale draft save/);
  assert.deepEqual(await store.getDraftReview(current.key), draft);
  await store.clearDraftReview(current.key);
  await assert.rejects(store.appendDraftReviewComment(current.key, "old", input), /stale/i);
  assert.equal(await store.getDraftReview(current.key), null);
  assert.equal((await store.appendDraftReviewComment(current.key, "new", input)).created, true);
});

test("AI review saves preserve immutable content and provenance", async () => {
  const { runtime } = fakeRuntime();
  const store = createStateStore(runtime, paths);
  const provenance = { runId: "run", version: 1, model: "test-model", thinkingLevel: "medium" };
  const first = await store.saveAiReview({ prKey: "pr", headSha: "head", answer: "answer", provenance, messages: [{ role: "pi", text: "answer" }] });
  const saved = await store.saveAiReview({ id: first.id, prKey: "pr", headSha: "head", answer: "answer" });
  assert.deepEqual(saved, first);
  await assert.rejects(store.saveAiReview({ ...first, answer: "changed" }), /immutable/i);
  await assert.rejects(store.saveAiReview({ ...first, messages: [] }), /immutable/i);
  await assert.rejects(store.saveAiReview({ ...first, provenance: { ...provenance, version: 2 } }), /immutable/i);
  assert.deepEqual(await store.listAiReviews("pr"), [first]);
});
