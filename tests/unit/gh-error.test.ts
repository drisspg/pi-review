import assert from "node:assert/strict";
import test from "node:test";

import { summarizeGhError } from "../../src/gh-error.js";

const OFFLINE = "can't reach GitHub (offline, or a network/VPN problem)";

function execError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh api graphql -f query=query($q: String!) { search(query: $q, type: ISSUE, first: 50) { issueCount } }\n${stderr}`), { stderr });
}

test("gh failures surface their reason, not the echoed command", () => {
  assert.equal(summarizeGhError(execError("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n")), OFFLINE);
  assert.equal(summarizeGhError(execError("Post \"https://api.github.com/graphql\": dial tcp 172.182.252.137:443: connect: network is unreachable\n")), OFFLINE);
  assert.equal(summarizeGhError(execError("gh: HTTP 502\n")), "HTTP 502");
  assert.equal(summarizeGhError(execError("GraphQL: Something went wrong while executing your query.\n")), "GraphQL: Something went wrong while executing your query.");
  assert.equal(summarizeGhError(new Error("plain failure")), "plain failure");
});
