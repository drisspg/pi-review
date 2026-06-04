import assert from "node:assert/strict";
import test from "node:test";

import { createGpuWorkspaceStore, type GpuWorkspaceRuntime } from "../../src/gpu-workspace.js";
import type { PullRequestRef } from "../../src/types.js";

const ref: PullRequestRef = { host: "github.com", owner: "pytorch", repo: "pytorch", number: 185924 };
const prKey = "github.com/pytorch/pytorch#185924";

type ExecFileCall = { command: string; args: string[] };
type SpawnCall = { command: string; args: string[]; timeoutMs: number };

function fakeRuntime(): { runtime: GpuWorkspaceRuntime; execFileCalls: ExecFileCall[]; spawnCalls: SpawnCall[] } {
  const execFileCalls: ExecFileCall[] = [];
  const spawnCalls: SpawnCall[] = [];
  return {
    execFileCalls,
    spawnCalls,
    runtime: {
      async execFile(command, args) {
        execFileCalls.push({ command, args });
        switch (args[0]) {
          case "reserve":
            return { stdout: "Reservation ID: 0c1baaac\nSSH Command: ssh gpu-dev-b200-mig-1g-c47db8\n", stderr: "" };
          case "show":
            return { stdout: "SSH Command: ssh gpu-dev-b200-mig-1g-c47db8\n", stderr: "" };
          case "cancel":
            return { stdout: `cancelled ${args[1]}\n`, stderr: "" };
          default:
            throw new Error(`unexpected gpu-dev command: ${args.join(" ")}`);
        }
      },
      async spawn(command, args, timeoutMs) {
        spawnCalls.push({ command, args, timeoutMs });
        return { stdout: "GPU 0: NVIDIA B200\n", stderr: "", exitCode: 0, signal: null };
      },
    },
  };
}

test("creates a workspace through an injectable gpu-dev runtime", async () => {
  const { runtime, execFileCalls } = fakeRuntime();
  const store = createGpuWorkspaceStore(runtime);

  const workspace = await store.createGpuWorkspace({ ref, gpuType: "b200-mig-1g", ttlHours: 0.25 });

  assert.equal(workspace.id, "0c1baaac");
  assert.equal(workspace.uri, "gpu-dev://ws/0c1baaac");
  assert.equal(workspace.attachCommand, "gpu-dev connect 0c1baaac");
  assert.equal(workspace.sshHost, "gpu-dev-b200-mig-1g-c47db8");
  assert.deepEqual(execFileCalls[0]?.args, ["reserve", "--gpu-type", "b200-mig-1g", "--gpus", "1", "--hours", "0.25", "--name", "pi-review-pytorch-pytorch-185924", "--no-persist", "--no-connect", "--no-interactive"]);
});

test("deduplicates concurrent create-or-reuse requests per PR", async () => {
  const { runtime, execFileCalls } = fakeRuntime();
  const store = createGpuWorkspaceStore(runtime);

  const [first, second] = await Promise.all([
    store.createOrReuseGpuWorkspace(prKey, { ref, gpuType: "b200-mig-1g" }),
    store.createOrReuseGpuWorkspace(prKey, { ref, gpuType: "b200-mig-1g" }),
  ]);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.workspace.id, second.workspace.id);
  assert.equal(execFileCalls.filter((call) => call.args[0] === "reserve").length, 1);
  assert.equal(store.gpuWorkspaceForPr(prKey)?.id, "0c1baaac");
});

test("exec resolves the SSH host through gpu-dev show and runs ssh", async () => {
  const { runtime, execFileCalls, spawnCalls } = fakeRuntime();
  const store = createGpuWorkspaceStore(runtime);

  const result = await store.execGpuWorkspace("0c1baaac", "nvidia-smi -L", 1234);

  assert.equal(result.stdout, "GPU 0: NVIDIA B200\n");
  assert.deepEqual(execFileCalls.at(-1)?.args, ["show", "0c1baaac"]);
  assert.deepEqual(spawnCalls[0], { command: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "gpu-dev-b200-mig-1g-c47db8", "nvidia-smi -L"], timeoutMs: 1234 });
});

test("unregister only removes matching workspace ids", async () => {
  const { runtime } = fakeRuntime();
  const store = createGpuWorkspaceStore(runtime);
  await store.createOrReuseGpuWorkspace(prKey, { ref, gpuType: "b200-mig-1g" });

  assert.equal(store.unregisterGpuWorkspace(prKey, "deadbeef"), false);
  assert.equal(store.gpuWorkspaceForPr(prKey)?.id, "0c1baaac");
  assert.equal(store.unregisterGpuWorkspace(prKey, "0c1baaac"), true);
  assert.equal(store.gpuWorkspaceForPr(prKey), null);
});
