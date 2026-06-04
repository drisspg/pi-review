import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { createGpuWorkspace, deleteGpuWorkspace, execGpuWorkspace, type GpuWorkspaceExecResult } from "../src/gpu-workspace.js";
import { parsePullRequestRef } from "../src/pr.js";

type Options = {
  pr: string | null;
  prKey: string | null;
  latestRepo: string | null;
  gpuType: string;
  ttlHours: number;
  setup: boolean;
  includeSubmodules: boolean;
  execCommands: string[];
  cancel: boolean;
};

type SavedPullRequest = {
  key: string;
  url: string;
  lastOpenedAt: string;
};

type SavedState = {
  prs?: SavedPullRequest[];
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prInput = await prInputFromOptions(options);
  const workspace = await createGpuWorkspace({ ref: parsePullRequestRef(prInput), gpuType: options.gpuType, ttlHours: options.ttlHours, includeSubmodules: options.includeSubmodules });
  console.log(JSON.stringify(workspace, null, 2));

  try {
    if (options.setup) {
      if (workspace.id == null) throw new Error("Workspace id was not detected");
      const result = await execGpuWorkspace(workspace.id, `${workspace.setupCommand} && git status --short --branch | head -40`);
      printExecResult(result);
    }

    for (const command of options.execCommands) {
      if (workspace.id == null) throw new Error("Workspace id was not detected");
      printExecResult(await execGpuWorkspace(workspace.id, command));
    }
  } finally {
    if (options.cancel && workspace.id != null) await cancelWorkspace(workspace.id);
  }
}

function parseArgs(args: string[]): Options {
  let pr: string | null = null;
  let prKey: string | null = null;
  let latestRepo: string | null = null;
  let gpuType = "b200-mig-1g";
  let ttlHours = 0.084;
  let setup = false;
  const execCommands: string[] = [];
  let includeSubmodules = false;
  let cancel = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--pr":
        pr = requiredValue(args, index += 1, arg);
        break;
      case "--pr-key":
        prKey = requiredValue(args, index += 1, arg);
        break;
      case "--latest-repo":
        latestRepo = requiredValue(args, index += 1, arg);
        break;
      case "--gpu-type":
        gpuType = requiredValue(args, index += 1, arg);
        break;
      case "--ttl-hours":
        ttlHours = Number(requiredValue(args, index += 1, arg));
        break;
      case "--setup":
        setup = true;
        break;
      case "--submodules":
        includeSubmodules = true;
        break;
      case "--exec":
        execCommands.push(requiredValue(args, index += 1, arg));
        break;
      case "--keep":
        cancel = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if ([pr, prKey, latestRepo].filter((value) => value != null).length !== 1) throw new Error("Usage: npm run gpu:workspace -- --pr https://github.com/pytorch/pytorch/pull/185264 | --pr-key github.com/pytorch/pytorch#185264 | --latest-repo pytorch/pytorch [--gpu-type b200-mig-1g] [--setup] [--submodules] [--exec 'nvidia-smi -L'] [--keep]");
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("--ttl-hours must be positive");
  return { pr, prKey, latestRepo, gpuType, ttlHours, setup, includeSubmodules, execCommands, cancel };
}

async function prInputFromOptions(options: Options): Promise<string> {
  if (options.pr != null) return options.pr;
  const prs = await savedPullRequests();
  if (options.prKey != null) {
    return prs.find((pr) => pr.key.toLowerCase() === options.prKey?.toLowerCase())?.url ?? prInputFromKey(options.prKey);
  }
  if (options.latestRepo != null) {
    const repo = options.latestRepo.toLowerCase();
    const pr = prs.filter((candidate) => candidate.key.toLowerCase().startsWith(`github.com/${repo}#`)).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0];
    if (pr == null) throw new Error(`No saved PR found for ${options.latestRepo}`);
    return pr.url;
  }
  throw new Error("Expected PR input");
}

async function savedPullRequests(): Promise<SavedPullRequest[]> {
  const statePath = resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as SavedState;
  return state.prs ?? [];
}

function prInputFromKey(key: string): string {
  const match = key.match(/^github\.com\/([^/]+)\/([^#]+)#(\d+)$/);
  if (match == null) return key;
  return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`;
}

function printExecResult(result: GpuWorkspaceExecResult): void {
  console.log(JSON.stringify({ id: result.id, command: result.command, sshHost: result.sshHost, exitCode: result.exitCode, signal: result.signal }, null, 2));
  if (result.stdout.trim().length > 0) console.log(result.stdout.trim());
  if (result.stderr.trim().length > 0) console.error(result.stderr.trim());
  if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
}

async function cancelWorkspace(id: string): Promise<void> {
  const { stdout, stderr } = await deleteGpuWorkspace(id);
  if (stdout.trim().length > 0) console.log(stdout.trim());
  if (stderr.trim().length > 0) console.error(stderr.trim());
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value == null || value.startsWith("--")) throw new Error(`Expected value after ${flag}`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
