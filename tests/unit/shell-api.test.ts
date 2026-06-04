import assert from "node:assert/strict";
import test from "node:test";

import { createShellApi } from "../../src/shell-api.js";
import type { LogEntry } from "../../src/logger.js";
import type { StoredPullRequest } from "../../src/types.js";

const pr: StoredPullRequest = {
  author: "author",
  baseSha: "base",
  body: null,
  existingCommentCount: 0,
  filesChanged: 1,
  headSha: "head",
  key: "github.com/o/r#1",
  lastOpenedAt: "now",
  lastReviewedHeadSha: null,
  lastReviewEvent: null,
  ref: { host: "github.com", owner: "o", repo: "r", number: 1 },
  reviewDecision: null,
  state: "open",
  title: "title",
  url: "https://github.com/o/r/pull/1",
};

const log: LogEntry = {
  id: 1,
  level: "info",
  message: "message",
  scope: "scope",
  timestamp: "now",
};

test("shell API returns health status", () => {
  const api = createShellApi({
    async listRecentPullRequests() {
      return [];
    },
    logEntries() {
      return [];
    },
  });

  assert.deepEqual(api.health(), { ok: true });
});

test("shell API lists recent PRs through injected state", async () => {
  const api = createShellApi({
    async listRecentPullRequests() {
      return [pr];
    },
    logEntries() {
      return [];
    },
  });

  assert.deepEqual(await api.prs(), { prs: [pr] });
});

test("shell API returns log entries through injected logger", () => {
  const api = createShellApi({
    async listRecentPullRequests() {
      return [];
    },
    logEntries() {
      return [log];
    },
  });

  assert.deepEqual(api.logs(), { logs: [log] });
});
