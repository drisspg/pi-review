import assert from "node:assert/strict";
import test from "node:test";

import { parsePullRequestKey } from "../../src/pr.js";

test("parses persisted pull request keys", () => {
  assert.deepEqual(parsePullRequestKey("github.com/org/repo#42"), { host: "github.com", owner: "org", repo: "repo", number: 42 });
  assert.equal(parsePullRequestKey("org/repo#42"), null);
  assert.equal(parsePullRequestKey("github.com/org/repo#not-a-number"), null);
});
