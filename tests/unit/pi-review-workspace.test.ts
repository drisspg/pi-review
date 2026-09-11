import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installReviewWorkspaceGuidance, REVIEW_WORKSPACE_ENV, reviewWorkspaceEnvironment, reviewWorkspaceInstructions } from "../../src/pi-review-workspace.js";

const workspace = { prKey: "github.com/org/repo#1", root: "/review/pr-1", headSha: "abcdef123", scope: "inline-1", target: { path: "kernel.py", startLine: 10, line: 12, side: "RIGHT" as const } };

test("review workspace guidance gives concrete scope and bounded dependency discovery instead of disk scans", () => {
  const text = reviewWorkspaceInstructions(workspace, { platform: "darwin", arch: "arm64", virtualEnv: "/env", worktreePython: "/review/pr-1/.venv/bin/python" });
  for (const token of [workspace.prKey, workspace.root, workspace.headSha, "kernel.py", "darwin/arm64", "/env"]) assert.ok(text.includes(token));
  assert.match(text, /app-managed detached PR snapshot/);
  assert.match(text, /macOS host cannot execute NVIDIA CUDA kernels/);
  assert.match(text, /importlib\.util\.find_spec/);
  assert.match(text, /stop local discovery/);
  assert.match(text, /Do not run find \//);
  assert.match(text, /Piping to head.*does not bound/);
  assert.match(text, /Do not use git status/);
  assert.match(text, /Do not stop other sessions, security agents/);
  const linux = reviewWorkspaceInstructions(workspace, { platform: "linux", arch: "x64" });
  assert.match(linux, /GPU availability has not been probed/);
  assert.doesNotMatch(linux, /cannot execute NVIDIA CUDA/);
});

test("review metadata stays bounded without hiding the total changed-file count", () => {
  const env = reviewWorkspaceEnvironment({ ...workspace, changedFiles: Array.from({ length: 1000 }, (_, i) => `src/${i}.ts`) });
  const snapshot = JSON.parse(env[REVIEW_WORKSPACE_ENV]);
  assert.equal(snapshot.changedFiles.length, 12);
  assert.equal(snapshot.changedFileCount, 1000);
  const text = reviewWorkspaceInstructions(snapshot, { platform: "darwin", arch: "arm64" });
  assert.match(text, /"changedFileCount":1000/);
  assert.ok(text.length < 6000);
});

test("workspace guidance reaches parent prompts and single/parallel child tasks, not management calls", (t) => {
  const previous = process.env[REVIEW_WORKSPACE_ENV];
  t.after(() => { if (previous === undefined) delete process.env[REVIEW_WORKSPACE_ENV]; else process.env[REVIEW_WORKSPACE_ENV] = previous; });
  const handlers = new Map<string, (event: any) => any>();
  const pi = { on: (name: string, handler: (event: any) => any) => handlers.set(name, handler) } as ExtensionAPI;
  delete process.env[REVIEW_WORKSPACE_ENV];
  installReviewWorkspaceGuidance(pi);
  assert.equal(handlers.size, 0);
  Object.assign(process.env, reviewWorkspaceEnvironment(workspace));
  installReviewWorkspaceGuidance(pi);
  const prompt = handlers.get("before_agent_start")!({ systemPrompt: "base prompt" });
  assert.ok(prompt.systemPrompt.startsWith("base prompt\n\n"));
  assert.match(prompt.systemPrompt, /kernel.py/);
  const single = { task: "Check the stride assumption", cwd: "/review/pr-1" };
  handlers.get("tool_call")!({ toolName: "subagent", input: single });
  assert.match(single.task, /Do not run find \//);
  assert.ok(single.task.endsWith("Delegated question:\nCheck the stride assumption"));
  const once = single.task;
  handlers.get("tool_call")!({ toolName: "subagent", input: single });
  assert.equal(single.task, once);
  const parallel = { action: "execute", tasks: [{ task: "Check callers" }, { task: "Check tests" }] };
  handlers.get("tool_call")!({ toolName: "subagent", input: parallel });
  for (const child of parallel.tasks) assert.match(child.task, /abcdef123/);
  for (const action of ["status", "wait", "cancel"]) {
    const input = { action, task: "unchanged" };
    handlers.get("tool_call")!({ toolName: "subagent", input });
    assert.equal(input.task, "unchanged");
  }
  const other = { task: "unchanged" };
  handlers.get("tool_call")!({ toolName: "bash", input: other });
  assert.equal(other.task, "unchanged");
});
