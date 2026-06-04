import assert from "node:assert/strict";
import test from "node:test";

import type { GpuWorkspace, GpuWorkspaceStore } from "../../src/gpu-workspace.js";
import { createGpuWorkspaceTool } from "../../src/gpu-workspace-tool.js";

const prKey = "github.com/pytorch/pytorch#185924";
const workspace: GpuWorkspace = {
  id: "0c1baaac",
  uri: "gpu-dev://ws/0c1baaac",
  prRef: "pr/185924",
  gpuType: "b200-mig-1g",
  gpuCount: 1,
  ttlHours: 0.25,
  command: "gpu-dev reserve",
  attachCommand: "gpu-dev connect 0c1baaac",
  showCommand: "gpu-dev show 0c1baaac",
  sshHost: "gpu-dev-b200-mig-1g-c47db8",
  setupProfile: "pytorch-pr",
  setupCommand: "cd ~/pytorch",
  setupScript: "#!/usr/bin/env bash",
  stdout: "",
  stderr: "",
  createdAt: "2026-06-04T00:00:00.000Z",
};

type ToolResult = { details: unknown };

function fakeStore(initialWorkspace: GpuWorkspace | null = workspace): { store: GpuWorkspaceStore; calls: string[] } {
  let currentWorkspace = initialWorkspace;
  const calls: string[] = [];
  return {
    calls,
    store: {
      gpuWorkspaceForPr(key) {
        calls.push(`status:${key}`);
        return currentWorkspace;
      },
      unregisterGpuWorkspace(key, id) {
        calls.push(`unregister:${key}:${id ?? ""}`);
        currentWorkspace = null;
        return true;
      },
      async createOrReuseGpuWorkspace(key, request) {
        calls.push(`allocate:${key}:${request.ref.owner}/${request.ref.repo}#${request.ref.number}:${request.gpuType}`);
        currentWorkspace = workspace;
        return { workspace, reused: false };
      },
      async createGpuWorkspace() {
        return workspace;
      },
      async deleteGpuWorkspace(id) {
        calls.push(`delete:${id}`);
        return { id, stdout: "deleted", stderr: "" };
      },
      async execGpuWorkspace(id, command, timeoutMs) {
        calls.push(`exec:${id}:${command}:${timeoutMs}`);
        return { id, command, sshHost: workspace.sshHost!, stdout: "ok", stderr: "", exitCode: 0, signal: null };
      },
    },
  };
}

async function executeTool(store: GpuWorkspaceStore, params: Record<string, unknown>): Promise<ToolResult> {
  return await (createGpuWorkspaceTool(prKey, store).execute as (...args: unknown[]) => Promise<ToolResult>)("call", params);
}

test("gpu_workspace status returns shared workspace", async () => {
  const { store } = fakeStore();

  assert.deepEqual((await executeTool(store, { action: "status" })).details, { workspace });
});

test("gpu_workspace allocate parses PR key and delegates to store", async () => {
  const { store, calls } = fakeStore(null);

  assert.deepEqual((await executeTool(store, { action: "allocate", gpuType: "b200-mig-1g" })).details, { workspace, reused: false });
  assert.deepEqual(calls, ["status:github.com/pytorch/pytorch#185924", "allocate:github.com/pytorch/pytorch#185924:pytorch/pytorch#185924:b200-mig-1g"]);
});

test("gpu_workspace exec uses registered workspace id", async () => {
  const { store, calls } = fakeStore();

  assert.deepEqual((await executeTool(store, { action: "exec", command: " nvidia-smi -L ", timeoutMs: 1234 })).details, { result: { id: "0c1baaac", command: "nvidia-smi -L", sshHost: workspace.sshHost, stdout: "ok", stderr: "", exitCode: 0, signal: null } });
  assert.deepEqual(calls, ["status:github.com/pytorch/pytorch#185924", "exec:0c1baaac:nvidia-smi -L:1234"]);
});

test("gpu_workspace delete cancels then unregisters workspace", async () => {
  const { store, calls } = fakeStore();

  assert.deepEqual((await executeTool(store, { action: "delete" })).details, { deleted: true, result: { id: "0c1baaac", stdout: "deleted", stderr: "" } });
  assert.deepEqual(calls, ["status:github.com/pytorch/pytorch#185924", "delete:0c1baaac", "unregister:github.com/pytorch/pytorch#185924:0c1baaac"]);
});
