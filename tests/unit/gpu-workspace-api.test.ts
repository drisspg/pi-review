import assert from "node:assert/strict";
import test from "node:test";

import { gpuWorkspaceCreateResponse, gpuWorkspaceDeleteResponse, gpuWorkspaceExecResponse, gpuWorkspaceStatusResponse } from "../../src/gpu-workspace-api.js";
import type { GpuWorkspace, GpuWorkspaceStore } from "../../src/gpu-workspace.js";

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

function fakeStore(): { store: GpuWorkspaceStore; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    store: {
      gpuWorkspaceForPr(prKey) {
        calls.push(`status:${prKey}`);
        return workspace;
      },
      unregisterGpuWorkspace(prKey, id) {
        calls.push(`unregister:${prKey}:${id ?? ""}`);
        return true;
      },
      async createOrReuseGpuWorkspace(prKey, request) {
        calls.push(`create:${prKey}:${request.gpuType}:${request.ttlHours}`);
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

test("GPU API status resolves workspace by PR key", async () => {
  const { store, calls } = fakeStore();

  assert.deepEqual(await gpuWorkspaceStatusResponse({ prKey: "github.com/pytorch/pytorch#185924" }, store), { workspace });
  assert.deepEqual(calls, ["status:github.com/pytorch/pytorch#185924"]);
});

test("GPU API create parses PR URL and delegates to store", async () => {
  const { store, calls } = fakeStore();

  assert.deepEqual(await gpuWorkspaceCreateResponse({ prUrl: "https://github.com/pytorch/pytorch/pull/185924", gpuType: "b200-mig-1g", ttlHours: 0.25 }, store), { workspace, reused: false });
  assert.deepEqual(calls, ["create:github.com/pytorch/pytorch#185924:b200-mig-1g:0.25"]);
});

test("GPU API delete cancels before unregistering matching state", async () => {
  const { store, calls } = fakeStore();

  assert.deepEqual(await gpuWorkspaceDeleteResponse({ prUrl: "https://github.com/pytorch/pytorch/pull/185924", id: "0c1baaac" }, store), { result: { id: "0c1baaac", stdout: "deleted", stderr: "" } });
  assert.deepEqual(calls, ["delete:0c1baaac", "unregister:github.com/pytorch/pytorch#185924:0c1baaac"]);
});

test("GPU API exec trims command and delegates timeout", async () => {
  const { store, calls } = fakeStore();

  assert.deepEqual(await gpuWorkspaceExecResponse({ id: "0c1baaac", command: " nvidia-smi -L ", timeoutMs: 1234 }, store), { result: { id: "0c1baaac", command: "nvidia-smi -L", sshHost: workspace.sshHost, stdout: "ok", stderr: "", exitCode: 0, signal: null } });
  assert.deepEqual(calls, ["exec:0c1baaac:nvidia-smi -L:1234"]);
});
