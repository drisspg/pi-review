import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { defaultGpuWorkspaceStore, type GpuWorkspaceStore } from "./gpu-workspace.js";
import type { PullRequestRef } from "./types.js";

type GpuWorkspaceToolParams = {
  action: "status" | "allocate" | "exec" | "delete";
  command?: string;
  gpuType?: string;
  includeSubmodules?: boolean;
  timeoutMs?: number;
  ttlHours?: number;
};

function refFromPrKey(prKey: string): PullRequestRef {
  const match = prKey.match(/^([^/]+)\/([^/]+)\/([^#]+)#(\d+)$/);
  if (match == null) throw new Error(`Cannot allocate GPU workspace for invalid PR key: ${prKey}`);
  return { host: match[1], owner: match[2], repo: match[3], number: Number.parseInt(match[4], 10) };
}

function textToolResult(details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

export function createGpuWorkspaceTool(prKey: string, store: GpuWorkspaceStore = defaultGpuWorkspaceStore) {
  return defineTool({
    name: "gpu_workspace",
    label: "GPU Workspace",
    description: "Allocate, inspect, delete, and run shell commands on the shared GPU workspace for the current PR.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("status"), Type.Literal("allocate"), Type.Literal("exec"), Type.Literal("delete")]),
      command: Type.Optional(Type.String({ description: "Shell command to run for action=exec." })),
      gpuType: Type.Optional(Type.String({ description: "GPU type for action=allocate, for example b200-mig-1g." })),
      includeSubmodules: Type.Optional(Type.Boolean({ description: "Whether PyTorch setup should initialize submodules." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Command timeout for action=exec." })),
      ttlHours: Type.Optional(Type.Number({ description: "Reservation lifetime for action=allocate." })),
    }),
    async execute(_toolCallId, params) {
      const toolParams = params as GpuWorkspaceToolParams;
      const existing = store.gpuWorkspaceForPr(prKey);
      switch (toolParams.action) {
        case "status":
          return textToolResult({ workspace: existing });
        case "allocate":
          return textToolResult(await store.createOrReuseGpuWorkspace(prKey, { ref: refFromPrKey(prKey), gpuType: toolParams.gpuType ?? "b200-mig-1g", ttlHours: toolParams.ttlHours, includeSubmodules: toolParams.includeSubmodules }));
        case "exec": {
          if (existing?.id == null) throw new Error("No GPU workspace is registered for this PR. Call gpu_workspace with action=allocate first.");
          if (toolParams.command == null || toolParams.command.trim().length === 0) throw new Error("action=exec requires command.");
          return textToolResult({ result: await store.execGpuWorkspace(existing.id, toolParams.command.trim(), toolParams.timeoutMs) });
        }
        case "delete": {
          if (existing?.id == null) {
            store.unregisterGpuWorkspace(prKey);
            return textToolResult({ deleted: false, reason: "No GPU workspace is registered for this PR." });
          }
          const result = await store.deleteGpuWorkspace(existing.id);
          store.unregisterGpuWorkspace(prKey, existing.id);
          return textToolResult({ deleted: true, result });
        }
      }
    },
  });
}
