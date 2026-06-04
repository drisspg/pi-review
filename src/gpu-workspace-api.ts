import { defaultGpuWorkspaceStore, type GpuWorkspaceStore } from "./gpu-workspace.js";
import { prKey, parsePullRequestRef } from "./pr.js";

export function prKeyFromGpuWorkspacePayload(payload: Record<string, unknown>): string {
  if (typeof payload.prKey === "string" && payload.prKey.trim().length > 0) return payload.prKey.trim();
  if (typeof payload.prUrl === "string" && payload.prUrl.trim().length > 0) return prKey(parsePullRequestRef(payload.prUrl));
  throw new Error("Expected prKey or prUrl");
}

export async function gpuWorkspaceStatusResponse(payload: Record<string, unknown>, store: GpuWorkspaceStore = defaultGpuWorkspaceStore): Promise<Record<string, unknown>> {
  return { workspace: store.gpuWorkspaceForPr(prKeyFromGpuWorkspacePayload(payload)) };
}

export async function gpuWorkspaceCreateResponse(payload: Record<string, unknown>, store: GpuWorkspaceStore = defaultGpuWorkspaceStore): Promise<Record<string, unknown>> {
  if (typeof payload.prUrl !== "string" || typeof payload.gpuType !== "string") throw new Error("Expected prUrl and gpuType");
  const ref = parsePullRequestRef(payload.prUrl);
  const { workspace, reused } = await store.createOrReuseGpuWorkspace(prKey(ref), { ref, gpuType: payload.gpuType, gpuCount: typeof payload.gpuCount === "number" ? payload.gpuCount : undefined, ttlHours: typeof payload.ttlHours === "number" ? payload.ttlHours : undefined, includeSubmodules: payload.includeSubmodules === true });
  return { workspace, reused };
}

export async function gpuWorkspaceDeleteResponse(payload: Record<string, unknown>, store: GpuWorkspaceStore = defaultGpuWorkspaceStore): Promise<Record<string, unknown>> {
  if (typeof payload.id !== "string" || payload.id.trim().length === 0) throw new Error("Expected workspace id");
  const id = payload.id.trim();
  const result = await store.deleteGpuWorkspace(id);
  if (typeof payload.prKey === "string" || typeof payload.prUrl === "string") store.unregisterGpuWorkspace(prKeyFromGpuWorkspacePayload(payload), id);
  return { result };
}

export async function gpuWorkspaceExecResponse(payload: Record<string, unknown>, store: GpuWorkspaceStore = defaultGpuWorkspaceStore): Promise<Record<string, unknown>> {
  if (typeof payload.id !== "string" || payload.id.trim().length === 0 || typeof payload.command !== "string" || payload.command.trim().length === 0) throw new Error("Expected workspace id and command");
  return { result: await store.execGpuWorkspace(payload.id.trim(), payload.command.trim(), typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined) };
}
