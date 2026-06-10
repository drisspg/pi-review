import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient } from "../../src/github.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 185924 };

type ExecCall = { command: string; args: string[] };

function fakeRuntime(options: { failMutations?: boolean; gitattributes?: string } = {}) {
  const execCalls: ExecCall[] = [];
  const writes: Array<{ path: string; data: string }> = [];
  const removals: string[] = [];
  return {
    execCalls,
    writes,
    removals,
    runtime: {
      async execFile(command: string, args: string[]) {
        execCalls.push({ command, args });
        const key = args[1];
        if (args[0] === "api" && args.includes("--input")) {
          if (options.failMutations) throw new Error("mutation failed");
          return { stdout: JSON.stringify({ ok: true }), stderr: "" };
        }
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924") return { stdout: JSON.stringify({ number: 185924, title: "PR title", html_url: "https://github.com/pytorch/pytorch/pull/185924", state: "open", body: null, user: { login: "alice" }, base: { ref: "main", sha: "base", repo: { full_name: "pytorch/pytorch", clone_url: "git", html_url: "repo" } }, head: { ref: "branch", sha: "head", repo: null } }), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924/files") return { stdout: JSON.stringify([{ filename: "torch/a.py", status: "modified", additions: 1, deletions: 2, changes: 3, patch: "@@" }, { filename: "generated/model.py", status: "modified", additions: 10, deletions: 0, changes: 10, patch: "@@" }]), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924/comments") return { stdout: JSON.stringify([{ id: 123, path: "torch/a.py", line: 7, side: "RIGHT", body: "note", html_url: "comment" }]), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/issues/185924/comments") return { stdout: JSON.stringify([{ id: 456, body: "issue", html_url: "issue" }]), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924/reviews") return { stdout: JSON.stringify([{ id: 789, body: "summary", html_url: "review", state: "COMMENTED" }, { id: 790, body: "   ", html_url: "empty", state: "COMMENTED" }]), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/contents/.gitattributes?ref=head") return { stdout: options.gitattributes ?? "", stderr: "" };
        if (args[0] === "api" && key === "graphql" && args.some((arg) => String(arg).includes("reviewThreads"))) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-1", isResolved: true, comments: { nodes: [{ databaseId: 123 }] } }] } } } } }), stderr: "" };
        if (args[0] === "api" && key === "graphql") return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: "REVIEW_REQUIRED" } } } }), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/contents/torch/a.py?ref=head") return { stdout: "line\r\n", stderr: "" };
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
      },
      async listFileReviews() {
        return [];
      },
      async mkdtemp() {
        return "/tmp/pi-review-test";
      },
      now() {
        return "2026-06-04T00:00:00.000Z";
      },
      async rm(path: string) {
        removals.push(path);
      },
      async writeFile(path: string, data: string) {
        writes.push({ path, data });
      },
    },
  };
}

test("GitHub client fetches and combines PR review data", async () => {
  const { runtime } = fakeRuntime();
  const data = await createGitHubClient(runtime).fetchPullRequestReviewData(ref);

  assert.equal(data.pr.key, "github.com/pytorch/pytorch#185924");
  assert.equal(data.pr.reviewDecision, "REVIEW_REQUIRED");
  assert.equal(data.pr.existingCommentCount, 3);
  assert.equal(data.comments[0]?.thread_id, "thread-1");
  assert.equal(data.comments[0]?.thread_resolved, true);
  assert.equal(data.reviewSummaries.length, 1);
  assert.equal(data.fileReviews[0]?.viewed, false);
  assert.equal(data.fileReviews[0]?.updatedAt, "2026-06-04T00:00:00.000Z");
});

test("GitHub client marks files flagged linguist-generated", async () => {
  const { runtime } = fakeRuntime({ gitattributes: "generated/** linguist-generated=true\n" });

  const data = await createGitHubClient(runtime).fetchPullRequestReviewData(ref);

  assert.deepEqual(data.files.map((file) => [file.filename, file.generated ?? false]), [["torch/a.py", false], ["generated/model.py", true]]);
  assert.deepEqual(data.fileReviews.map((review) => review.path), ["torch/a.py", "generated/model.py"]);
  assert.equal(data.pr.filesChanged, 2);
});

test("GitHub client fetchFileText uses raw content header and normalizes newlines", async () => {
  const { runtime, execCalls } = fakeRuntime();

  assert.equal(await createGitHubClient(runtime).fetchFileText(ref, "torch/a.py", "head"), "line\n");
  assert.deepEqual(execCalls[0], { command: "gh", args: ["api", "/repos/pytorch/pytorch/contents/torch/a.py?ref=head", "-H", "Accept: application/vnd.github.raw"] });
});

test("GitHub client writes mutation payloads through temp files and cleans successful calls", async () => {
  const { runtime, execCalls, writes, removals } = fakeRuntime();

  assert.deepEqual(await createGitHubClient(runtime).submitPullRequestReview(ref, { event: "COMMENT", body: "ok" }), { ok: true });
  assert.deepEqual(writes, [{ path: "/tmp/pi-review-test/payload.json", data: JSON.stringify({ event: "COMMENT", body: "ok" }) }]);
  assert.deepEqual(execCalls[0], { command: "gh", args: ["api", "/repos/pytorch/pytorch/pulls/185924/reviews", "--method", "POST", "--input", "/tmp/pi-review-test/payload.json"] });
  assert.deepEqual(removals, ["/tmp/pi-review-test"]);
});

test("GitHub client preserves mutation payload temp directory on failure", async () => {
  const { runtime, removals } = fakeRuntime({ failMutations: true });

  await assert.rejects(createGitHubClient(runtime).addIssueComment(ref, "body"), /mutation failed/);
  assert.deepEqual(removals, []);
});

test("GitHub client mutation wrappers use expected endpoints and methods", async () => {
  const { runtime, execCalls } = fakeRuntime();
  const client = createGitHubClient(runtime);

  await client.replyToReviewComment(ref, 11, "reply");
  await client.addIssueComment(ref, "issue");
  await client.editReviewComment(ref, 12, "review edit");
  await client.editIssueComment(ref, 13, "issue edit");
  await client.editReviewSummary(ref, 14, "summary edit");

  assert.deepEqual(execCalls.map((call) => call.args), [
    ["api", "/repos/pytorch/pytorch/pulls/185924/comments/11/replies", "--method", "POST", "--input", "/tmp/pi-review-test/payload.json"],
    ["api", "/repos/pytorch/pytorch/issues/185924/comments", "--method", "POST", "--input", "/tmp/pi-review-test/payload.json"],
    ["api", "/repos/pytorch/pytorch/pulls/comments/12", "--method", "PATCH", "--input", "/tmp/pi-review-test/payload.json"],
    ["api", "/repos/pytorch/pytorch/issues/comments/13", "--method", "PATCH", "--input", "/tmp/pi-review-test/payload.json"],
    ["api", "/repos/pytorch/pytorch/pulls/185924/reviews/14", "--method", "PATCH", "--input", "/tmp/pi-review-test/payload.json"],
  ]);
});
