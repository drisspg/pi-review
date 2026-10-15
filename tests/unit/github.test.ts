import assert from "node:assert/strict";
import test from "node:test";

import { createGitHubClient } from "../../src/github.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 185924 };

type ExecCall = { command: string; args: string[] };

function fakeRuntime(options: { failMutations?: boolean; gitattributes?: string; landed?: boolean } = {}) {
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
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924") return { stdout: JSON.stringify({ number: 185924, title: "PR title", html_url: "https://github.com/pytorch/pytorch/pull/185924", state: options.landed ? "closed" : "open", merged: false, labels: options.landed ? [{ name: "Merged" }] : [], body: null, user: { login: "alice" }, base: { ref: "main", sha: "base", repo: { full_name: "pytorch/pytorch", clone_url: "git", html_url: "repo" } }, head: { ref: "branch", sha: "head", repo: null } }), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924/files") return { stdout: JSON.stringify([{ filename: "torch/a.py", status: "modified", additions: 1, deletions: 2, changes: 3, patch: "@@" }, { filename: "generated/model.py", status: "modified", additions: 10, deletions: 0, changes: 10, patch: "@@" }]), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924/comments") return { stdout: JSON.stringify([{ id: 123, path: "torch/a.py", line: 7, side: "RIGHT", body: "note", html_url: "comment" }]), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/issues/185924/comments") return { stdout: JSON.stringify([{ id: 456, body: "issue", html_url: "issue" }]), stderr: "" };
        if (args[0] === "api" && key === "/user") return { stdout: JSON.stringify({ login: "alice" }), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/pulls/185924/reviews") return { stdout: JSON.stringify([{ id: 789, body: "summary", html_url: "review", state: "COMMENTED", user: { login: "alice" }, commit_id: "aaa1111", submitted_at: "2026-05-01T00:00:00Z" }, { id: 790, body: "   ", html_url: "empty", state: "APPROVED", user: { login: "alice" }, commit_id: "bbb2222", submitted_at: "2026-06-01T00:00:00Z" }, { id: 791, body: "  ", html_url: "bob", state: "CHANGES_REQUESTED", user: { login: "bob" }, commit_id: "ccc3333", submitted_at: "2026-07-01T00:00:00Z" }]), stderr: "" };
        if (args[0] === "api" && key?.startsWith("/repos/pytorch/pytorch/contents/.gitattributes?ref=")) return { stdout: options.gitattributes ?? "", stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/compare/aaa1111...bbb2222") return { stdout: JSON.stringify({ total_commits: 2, files: [{ filename: "torch/a.py", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ interdiff" }, { filename: "generated/model.py", status: "modified", additions: 4, deletions: 0, changes: 4, patch: "@@" }] }), stderr: "" };
        if (args[0] === "api" && key?.startsWith("/repos/pytorch/pytorch/commits/head/check-runs")) return { stdout: JSON.stringify({ total_count: 4, check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: "build-url" }, { name: "lint", status: "completed", conclusion: "failure", html_url: "lint-url" }, { name: "docs", status: "in_progress", conclusion: null, html_url: "docs-url" }, { name: "optional", status: "completed", conclusion: "skipped", html_url: "optional-url" }] }), stderr: "" };
        if (args[0] === "api" && key === "graphql" && args.some((arg) => String(arg).includes("states: [PENDING]"))) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { id: "pr-id", reviews: { nodes: [{ id: "pending-id", state: "PENDING", viewerDidAuthor: true, body: "", updatedAt: "now", comments: { nodes: [{ id: "comment-id", path: "torch/a.py", line: 7, startLine: null, subjectType: "LINE", body: "private", url: "private-url" }], pageInfo: { hasNextPage: false, endCursor: null } } }] } } } } }), stderr: "" };
        if (args[0] === "api" && key === "graphql" && args.some((arg) => String(arg).includes("addPullRequestReviewThread"))) return { stdout: JSON.stringify({ data: { addPullRequestReviewThread: { thread: { id: "thread-id" } } } }), stderr: "" };
        if (args[0] === "api" && key === "graphql" && args.some((arg) => String(arg).includes("addPullRequestReview(input"))) return { stdout: JSON.stringify({ data: { addPullRequestReview: { pullRequestReview: { id: "pending-id" } } } }), stderr: "" };
        if (args[0] === "api" && key === "graphql" && args.some((arg) => String(arg).includes("reviewThreads"))) return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "thread-1", isResolved: true, comments: { nodes: [{ databaseId: 123 }] } }] } } } } }), stderr: "" };
        if (args[0] === "api" && key === "graphql") return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewDecision: "REVIEW_REQUIRED" } } } }), stderr: "" };
        if (args[0] === "api" && key === "/repos/pytorch/pytorch/contents/torch/a.py?ref=head") return { stdout: "line\r\n", stderr: "" };
        throw new Error(`unexpected gh call: ${args.join(" ")}`);
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
  assert.equal(data.pr.merged, false);
  assert.equal(data.pr.existingCommentCount, 3);
  assert.equal(data.comments[0]?.thread_id, "thread-1");
  assert.equal(data.comments[0]?.thread_resolved, true);
  assert.equal(data.reviewSummaries.length, 1);
  assert.equal(data.fileReviews[0]?.viewed, false);
  assert.equal(data.fileReviews[0]?.updatedAt, "2026-06-04T00:00:00.000Z");
  // Derived from the viewer's own latest submitted review, not bob's newer one.
  assert.equal(data.pr.lastReviewedHeadSha, "bbb2222");
  assert.equal(data.pr.lastReviewEvent, "APPROVE");
});

test("GitHub client recognizes bot-landed pull requests from their merged label", async () => {
  const { runtime } = fakeRuntime({ landed: true });

  const data = await createGitHubClient(runtime).fetchPullRequestReviewData(ref);

  assert.equal(data.pr.state, "closed");
  assert.equal(data.pr.merged, true);
});

test("GitHub client overlaps gitattributes with slower PR detail requests", async () => {
  const { runtime } = fakeRuntime();
  const execFile = runtime.execFile;
  let releaseFiles: (() => void) | null = null;
  let gitattributesStarted = false;
  runtime.execFile = async (command: string, args: string[]) => {
    if (args[1] === "/repos/pytorch/pytorch/pulls/185924/files") await new Promise<void>((resolve) => { releaseFiles = resolve; });
    if (args[1] === "/repos/pytorch/pytorch/contents/.gitattributes?ref=head") gitattributesStarted = true;
    return execFile(command, args);
  };

  const request = createGitHubClient(runtime).fetchPullRequestReviewData(ref);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(gitattributesStarted, true);
  assert.notEqual(releaseFiles, null);
  releaseFiles?.();
  await request;
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

test("GitHub client reads and mutates the current pending review through GraphQL", async () => {
  const { runtime, execCalls } = fakeRuntime();
  const client = createGitHubClient(runtime);

  assert.deepEqual(await client.fetchPendingPullRequestReview(ref), {
    pullRequestId: "pr-id",
    review: { id: "pending-id", body: "", updatedAt: "now", comments: [{ id: "comment-id", path: "torch/a.py", line: 7, startLine: null, subjectType: "LINE", body: "private", url: "private-url" }] },
  });
  assert.equal(await client.createPendingPullRequestReview(ref, "pr-id"), "pending-id");
  await client.addPendingPullRequestReviewThread(ref, "pending-id", { path: "torch/a.py", line: 9, startLine: 7, side: "RIGHT", body: "note" });

  const graphqlCalls = execCalls.filter((call) => call.args[1] === "graphql");
  assert.equal(graphqlCalls.length, 3);
  assert(graphqlCalls[1]?.args.some((arg) => String(arg).includes("addPullRequestReview(input")));
  assert(graphqlCalls[2]?.args.includes("line=9"));
  assert(graphqlCalls[2]?.args.includes("startLine=7"));
  assert(graphqlCalls[2]?.args.includes("side=RIGHT"));
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

test("GitHub client compares commits and marks generated files", async () => {
  const { runtime } = fakeRuntime({ gitattributes: "generated/** linguist-generated=true\n" });

  const result = await createGitHubClient(runtime).compareCommits(ref, "aaa1111", "bbb2222");

  assert.equal(result.totalCommits, 2);
  assert.deepEqual(result.files.map((file) => ({ filename: file.filename, generated: file.generated === true })), [
    { filename: "torch/a.py", generated: false },
    { filename: "generated/model.py", generated: true },
  ]);
});

test("GitHub client summarizes commit check runs", async () => {
  const { runtime } = fakeRuntime();

  const checks = await createGitHubClient(runtime).fetchCommitChecks(ref, "head");

  assert.deepEqual(checks, { total: 4, success: 1, failure: 1, pending: 1, neutral: 1, failures: [{ name: "lint", url: "lint-url" }] });
});

function searchRuntime(responses: Array<(args: string[]) => { stdout: string; stderr?: string } | Error>) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    runtime: {
      async execFile(_command: string, args: string[]) {
        calls.push(args);
        const respond = responses.shift();
        if (respond == null) throw new Error(`unexpected gh call: ${args.join(" ")}`);
        const result = respond(args);
        if (result instanceof Error) throw result;
        return { stdout: result.stdout, stderr: result.stderr ?? "" };
      },
      async mkdtemp() { return "/tmp/x"; },
      async rm() {},
      async writeFile() {},
      async sleep(ms: number) { sleeps.push(ms); },
      now() { return "2026-10-15T00:00:00.000Z"; },
    },
  };
}

const pullNode = (number: number) => ({ id: `PR_${number}`, number, title: `pr ${number}`, url: "u", body: "", createdAt: "c", updatedAt: "u", state: "OPEN", isDraft: false, labels: { nodes: [{ name: "triaged" }] } });
const page = (numbers: number[], next: string | null, total = 27) => ({ stdout: JSON.stringify({ data: { search: { issueCount: total, pageInfo: { hasNextPage: next != null, endCursor: next }, nodes: numbers.map(pullNode) } } }) });

test("workflow searches page through results instead of one heavy 50-node query", async () => {
  const h = searchRuntime([() => page([1, 2], "c1"), () => page([3], null)]);
  const result = await createGitHubClient(h.runtime as never).searchWorkflowPullRequests("repo:pytorch/pytorch is:pr is:open");
  assert.deepEqual(result.items.map((pr) => pr.number), [1, 2, 3]);
  assert.equal(result.total, 27);
  assert.ok(h.calls[0].includes("first=25"));
  assert.ok(h.calls[1].includes("after=c1"));
});

test("a GitHub-side search timeout is retried smaller and never reported as an empty queue", async () => {
  // gh exits non-zero but still prints the body: data.search is null next to a "Something went wrong" error.
  const timeout = () => Object.assign(new Error("Command failed: gh api graphql ...\nGraphQL: Something went wrong while executing your query."), { stdout: JSON.stringify({ data: { search: null }, errors: [{ message: "Something went wrong while executing your query." }] }) });
  const recovered = searchRuntime([timeout, () => page([7], null, 1)]);
  const result = await createGitHubClient(recovered.runtime as never).searchWorkflowPullRequests("repo:pytorch/pytorch is:pr is:open");
  assert.deepEqual(result.items.map((pr) => pr.number), [7]);
  assert.ok(recovered.calls[1].includes("first=10"), "the retry asks for a smaller page");
  assert.deepEqual(recovered.sleeps, [1500]);

  const stuck = searchRuntime([timeout, timeout]);
  await assert.rejects(createGitHubClient(stuck.runtime as never).searchWorkflowPullRequests("repo:pytorch/pytorch is:pr is:open"), /timed out on GitHub/);

  const auth = searchRuntime([() => new Error("Command failed\ngh: HTTP 401")]);
  await assert.rejects(createGitHubClient(auth.runtime as never).searchWorkflowPullRequests("repo:pytorch/pytorch is:pr is:open"), /401/);
  assert.equal(auth.calls.length, 1, "non-timeout errors are not retried");
});
