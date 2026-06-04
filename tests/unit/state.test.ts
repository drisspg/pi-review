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
  return { prs: [], fileReviews: [], focusScans: [], aiReviews: [], reviewMemory: [], reviewProfile: null };
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

test("saveReviewProfile trims text, records source count, and writes profile note", async () => {
  const { runtime, files } = fakeRuntime({ ...emptyState(), reviewMemory: [{ prKey: "a", event: "COMMENT", body: "body", comments: [], id: "memory", createdAt: "then" }] });

  const profile = await createStateStore(runtime, paths).saveReviewProfile("  profile text  ");

  assert.deepEqual(profile, { text: "profile text", sourceRecordCount: 1, updatedAt: "2026-06-04T00:00:00.000Z" });
  assert.equal(files.get(paths.reviewProfilePath), "profile text");
});

test("saveReviewMemory assigns metadata, prepends records, and writes preference prompt", async () => {
  const { runtime, files } = fakeRuntime({ ...emptyState(), reviewMemory: [{ prKey: "old", event: "COMMENT", body: "old", comments: [], id: "old-id", createdAt: "then" }] });

  const saved = await createStateStore(runtime, paths).saveReviewMemory({ prKey: "new", event: "APPROVE", body: "new body", comments: [{ path: "a.ts", line: 10, startLine: null, side: "RIGHT", body: "inline" }] });
  const persisted = JSON.parse(files.get(paths.statePath) ?? "{}") as AppState;

  assert.equal(saved.id, "uuid-1");
  assert.equal(saved.createdAt, "2026-06-04T00:00:00.000Z");
  assert.equal(persisted.reviewMemory[0]?.prKey, "new");
  assert.match(files.get(paths.reviewMemoryNotesPath) ?? "", /a\.ts:10: inline/);
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
  assert.equal(scans.some((scan) => scan.id === "old-19"), false);
});
