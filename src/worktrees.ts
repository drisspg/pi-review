import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { logger } from "./logger.js";
import type { PullRequestRef } from "./types.js";

const execFileAsync = promisify(execFile);
const STATE_ROOT = resolve(homedir(), ".pi", "agent", "state", "pi-pr-review");

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trim();
}

async function gitAllowFailure(args: string[], cwd?: string): Promise<void> {
  try {
    await git(args, cwd);
  } catch (error) {
    logger.debug("worktree", "ignored git failure", { args, error: error instanceof Error ? error.message : String(error) });
  }
}

export function worktreeDirForRef(ref: PullRequestRef): string {
  return resolve(STATE_ROOT, "worktrees", safe(ref.host), safe(ref.owner), safe(ref.repo), `pr-${ref.number}`);
}

export function repoDirForRef(ref: PullRequestRef): string {
  return resolve(STATE_ROOT, "repos", safe(ref.host), safe(ref.owner), safe(ref.repo));
}

export async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string): Promise<string> {
  const startedAt = performance.now();
  const repoDir = repoDirForRef(ref);
  const worktreeDir = worktreeDirForRef(ref);
  const remoteRef = `refs/pi-pr-review/pr-${ref.number}`;
  logger.info("worktree", "prepare start", { repoDir, worktreeDir });
  await mkdir(resolve(repoDir, ".."), { recursive: true });
  await mkdir(resolve(worktreeDir, ".."), { recursive: true });
  if (!existsSync(resolve(repoDir, ".git"))) {
    await git(["clone", cloneUrl, repoDir]);
  }
  await gitAllowFailure(["worktree", "remove", "--force", worktreeDir], repoDir);
  await rm(worktreeDir, { recursive: true, force: true });
  await git(["worktree", "prune"], repoDir);
  await git(["fetch", "--force", "origin", `pull/${ref.number}/head:${remoteRef}`], repoDir);
  await git(["worktree", "add", "--detach", "--force", worktreeDir, headSha], repoDir);
  logger.info("worktree", "prepare complete", { worktreeDir, ms: Math.round(performance.now() - startedAt) });
  return worktreeDir;
}

export async function cleanupPrWorktree(ref: PullRequestRef): Promise<string> {
  const repoDir = repoDirForRef(ref);
  const worktreeDir = worktreeDirForRef(ref);
  if (existsSync(resolve(repoDir, ".git"))) {
    await gitAllowFailure(["worktree", "remove", "--force", worktreeDir], repoDir);
    await gitAllowFailure(["worktree", "prune"], repoDir);
  }
  await rm(worktreeDir, { recursive: true, force: true });
  logger.info("worktree", "cleanup complete", { worktreeDir });
  return worktreeDir;
}
