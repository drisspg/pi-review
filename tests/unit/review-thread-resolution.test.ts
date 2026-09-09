import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient } from "../../src/github.js";

const ref = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 1 };

/** Exercise the real GraphQL adapter without writing to GitHub. */
function clientFor({ number = 1, repository = "pytorch/pytorch", mutationError = false, confirmed = true } = {}) {
  const calls: string[][] = [];
  const client = createGitHubClient({
    async execFile(_command, args) {
      calls.push(args);
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("query(")) return { stdout: JSON.stringify({ data: { node: { pullRequest: { number, repository: { nameWithOwner: repository } } } } }), stderr: "" };
      if (mutationError) return { stdout: JSON.stringify({ errors: [{ message: "Not authorized" }] }), stderr: "" };
      const operation = query.includes("unresolveReviewThread") ? "unresolveReviewThread" : "resolveReviewThread";
      return { stdout: JSON.stringify({ data: { [operation]: { thread: { id: "thread-1", isResolved: confirmed ? operation === "resolveReviewThread" : null } } } }), stderr: "" };
    },
  });
  return { client, calls };
}

test("thread resolution validates ownership and uses explicit resolve/unresolve mutations", async () => {
  const { client, calls } = clientFor();
  for (const resolved of [true, false]) assert.deepEqual(await client.setReviewThreadResolved(ref, "thread-1", resolved), { id: "thread-1", isResolved: resolved });
  assert.equal(calls.length, 4);
  assert.ok(calls[1].some((arg) => arg.includes("resolveReviewThread(input:")));
  assert.ok(calls[3].some((arg) => arg.includes("unresolveReviewThread(input:")));
});

test("thread resolution refuses other PRs, repositories and unsupported hosts without mutation", async () => {
  for (const options of [{ number: 2 }, { repository: "other/repo" }]) {
    const { client, calls } = clientFor(options);
    await assert.rejects(client.setReviewThreadResolved(ref, "thread-1", true), /does not belong/);
    assert.equal(calls.length, 1);
  }
  const { client, calls } = clientFor();
  await assert.rejects(client.setReviewThreadResolved({ ...ref, host: "enterprise.example" }, "thread-1", true), /github.com only/);
  assert.equal(calls.length, 0);
});

test("thread resolution surfaces GitHub errors and requires confirmation", async () => {
  await assert.rejects(clientFor({ mutationError: true }).client.setReviewThreadResolved(ref, "thread-1", true), /Not authorized/);
  await assert.rejects(clientFor({ confirmed: false }).client.setReviewThreadResolved(ref, "thread-1", true), /did not confirm/);
});
