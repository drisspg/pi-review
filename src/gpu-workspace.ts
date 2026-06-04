import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { PullRequestRef } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TTL_HOURS = 0.25;
const DEFAULT_GPU_COUNT = 1;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const MAX_EXEC_TIMEOUT_MS = 1_800_000;
const MAX_EXEC_OUTPUT_BYTES = 4 * 1024 * 1024;
const SUPPORTED_GPU_TYPES = new Set(["b300", "b200", "b200-mig-1g", "b200-mig-2g", "b200-mig-3g", "h200", "h100", "h100-mig-1g", "h100-mig-2g", "h100-mig-3g", "a100", "rtxpro6000", "a10g", "t4", "l4", "t4-small"]);
const workspaceByPr = new Map<string, GpuWorkspace>();
const pendingWorkspaceByPr = new Map<string, Promise<GpuWorkspace>>();

export type GpuWorkspaceRequest = {
  ref: PullRequestRef;
  gpuType: string;
  gpuCount?: number;
  ttlHours?: number;
  includeSubmodules?: boolean;
};

export type GpuWorkspace = {
  id: string | null;
  uri: string | null;
  prRef: string;
  gpuType: string;
  gpuCount: number;
  ttlHours: number;
  command: string;
  attachCommand: string | null;
  showCommand: string | null;
  sshHost: string | null;
  setupProfile: string;
  setupCommand: string;
  setupScript: string;
  stdout: string;
  stderr: string;
  createdAt: string;
};

export type GpuWorkspaceExecResult = {
  id: string;
  command: string;
  sshHost: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export function gpuWorkspaceForPr(prKey: string): GpuWorkspace | null {
  return workspaceByPr.get(prKey) ?? null;
}

export function unregisterGpuWorkspace(prKey: string, id?: string): boolean {
  const existing = workspaceByPr.get(prKey);
  if (id != null && existing?.id !== id) return false;
  workspaceByPr.delete(prKey);
  return existing != null;
}

export async function createOrReuseGpuWorkspace(prKey: string, request: GpuWorkspaceRequest): Promise<{ workspace: GpuWorkspace; reused: boolean }> {
  const existing = workspaceByPr.get(prKey);
  if (existing != null) return { workspace: existing, reused: true };
  const pending = pendingWorkspaceByPr.get(prKey);
  if (pending != null) return { workspace: await pending, reused: true };
  const created = createGpuWorkspace(request).then((workspace) => {
    workspaceByPr.set(prKey, workspace);
    return workspace;
  }).finally(() => pendingWorkspaceByPr.delete(prKey));
  pendingWorkspaceByPr.set(prKey, created);
  return { workspace: await created, reused: false };
}

export async function deleteGpuWorkspace(id: string): Promise<{ id: string; stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("gpu-dev", ["cancel", id], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return { id, stdout, stderr };
}

export async function execGpuWorkspace(id: string, command: string, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS): Promise<GpuWorkspaceExecResult> {
  const sshHost = await sshHostForWorkspace(id);
  const result = await spawnResult("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", sshHost, command], clampExecTimeout(timeoutMs));
  return { id, command, sshHost, ...result };
}

export async function createGpuWorkspace({ ref, gpuType, gpuCount = DEFAULT_GPU_COUNT, ttlHours = DEFAULT_TTL_HOURS, includeSubmodules = false }: GpuWorkspaceRequest): Promise<GpuWorkspace> {
  if (!isPyTorchRef(ref)) throw new Error("GPU workspace MVP only supports pytorch/pytorch PRs for now.");
  if (!SUPPORTED_GPU_TYPES.has(gpuType)) throw new Error(`Unsupported GPU type: ${gpuType}`);
  if (gpuCount !== 1) throw new Error("GPU workspace MVP only supports one GPU for now.");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24) throw new Error("TTL must be between 0 and 24 hours.");

  const setup = setupForRef(ref, includeSubmodules);
  const args = [
    "reserve",
    "--gpu-type", gpuType,
    "--gpus", String(gpuCount),
    "--hours", String(ttlHours),
    "--name", `pi-review-${ref.owner}-${ref.repo}-${ref.number}`,
    "--no-persist",
    "--no-connect",
    "--no-interactive",
  ];
  const { stdout, stderr } = await execFileAsync("gpu-dev", args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const id = reservationIdFromOutput(`${stdout}\n${stderr}`);
  const sshHost = sshHostFromOutput(`${stdout}\n${stderr}`);
  return {
    id,
    uri: id == null ? null : `gpu-dev://ws/${id}`,
    prRef: setup.ref,
    gpuType,
    gpuCount,
    ttlHours,
    command: shellCommand(["gpu-dev", ...args]),
    attachCommand: id == null ? null : `gpu-dev connect ${id}`,
    showCommand: id == null ? null : `gpu-dev show ${id}`,
    sshHost,
    setupProfile: setup.profile,
    setupCommand: setup.command,
    setupScript: setup.script,
    stdout,
    stderr,
    createdAt: new Date().toISOString(),
  };
}

function isPyTorchRef(ref: PullRequestRef): boolean {
  return ref.owner.toLowerCase() === "pytorch" && ref.repo.toLowerCase() === "pytorch";
}

function setupForRef(ref: PullRequestRef, includeSubmodules: boolean): { profile: string; ref: string; command: string; script: string } {
  const prRef = `pr/${ref.number}`;
  const branch = `gpu-dev-pr-${ref.number}`;
  const submoduleCommand = includeSubmodules ? " && git submodule update --init --recursive --jobs 8" : "";
  const submoduleScript = includeSubmodules ? "git submodule update --init --recursive --jobs 8\n" : "";
  const command = `sudo chown -R dev:dev /home/dev/pytorch && cd ~/pytorch && git reset --hard && git fetch origin pull/${ref.number}/head && git checkout -B ${branch} FETCH_HEAD${submoduleCommand}`;
  return {
    profile: includeSubmodules ? "pytorch-pr-submodules" : "pytorch-pr",
    ref: prRef,
    command,
    script: `#!/usr/bin/env bash
set -euo pipefail
sudo chown -R dev:dev /home/dev/pytorch
cd ~/pytorch
git reset --hard
git fetch origin pull/${ref.number}/head
git checkout -B ${branch} FETCH_HEAD
${submoduleScript}`,
  };
}

async function sshHostForWorkspace(id: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("gpu-dev", ["show", id], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const sshHost = sshHostFromOutput(`${stdout}\n${stderr}`);
  if (sshHost == null) throw new Error(`Could not find SSH host for workspace ${id}`);
  return sshHost;
}

function reservationIdFromOutput(output: string): string | null {
  const labelled = output.match(/(?:reservation|id)\D+([a-f0-9]{8})\b/i)?.[1];
  return labelled ?? output.match(/\b[a-f0-9]{8}\b/i)?.[0] ?? null;
}

function sshHostFromOutput(output: string): string | null {
  return output.match(/SSH Command:\s*ssh\s+([^\s]+)/)?.[1] ?? null;
}

function spawnResult(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveSpawn) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const killTimer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });
    child.on("close", (exitCode, signal) => {
      clearTimeout(killTimer);
      resolveSpawn({ stdout, stderr, exitCode, signal });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined) <= MAX_EXEC_OUTPUT_BYTES) return combined;
  return combined.slice(-MAX_EXEC_OUTPUT_BYTES);
}

function clampExecTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_EXEC_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS);
}

function shellCommand(parts: string[]): string {
  return parts.map((part) => /^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(" ");
}
