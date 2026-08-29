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

type WorktreeRuntime = {
  exists: (path: string) => boolean;
  git: (args: string[], cwd?: string) => Promise<string>;
  mkdir: (path: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
};

export type WorktreeService = {
  worktreeDirForRef: (ref: PullRequestRef) => string;
  repoDirForRef: (ref: PullRequestRef) => string;
  preparePrWorktree: (ref: PullRequestRef, cloneUrl: string, headSha: string) => Promise<string>;
  cleanupPrWorktree: (ref: PullRequestRef) => Promise<string>;
};

const defaultRuntime: WorktreeRuntime = {
  exists: existsSync,
  async git(args, cwd) {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });
    return stdout.trim();
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async rm(path) {
    await rm(path, { recursive: true, force: true });
  },
};

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function createWorktreeService(runtime: WorktreeRuntime = defaultRuntime, stateRoot = STATE_ROOT): WorktreeService {
  const preparations = new Map<string, Promise<string>>();

  function worktreeDirForRef(ref: PullRequestRef): string {
    return resolve(stateRoot, "worktrees", safe(ref.host), safe(ref.owner), safe(ref.repo), `pr-${ref.number}`);
  }

  function repoDirForRef(ref: PullRequestRef): string {
    return resolve(stateRoot, "repos", safe(ref.host), safe(ref.owner), safe(ref.repo));
  }

  async function gitAllowFailure(args: string[], cwd?: string): Promise<void> {
    try {
      await runtime.git(args, cwd);
    } catch (error) {
      logger.debug("worktree", "ignored git failure", { args, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function currentWorktreeHead(worktreeDir: string): Promise<string | null> {
    if (!runtime.exists(worktreeDir)) return null;
    try {
      const head = await runtime.git(["rev-parse", "HEAD"], worktreeDir);
      const indexPath = await runtime.git(["rev-parse", "--git-path", "index"], worktreeDir);
      if (!runtime.exists(indexPath)) {
        logger.warn("worktree", "existing worktree is missing its Git index", { worktreeDir, indexPath });
        return null;
      }
      return head;
    } catch (error) {
      logger.debug("worktree", "failed to read existing worktree head", { worktreeDir, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /** Prepare one PR worktree after earlier operations for the same path settle. */
  async function preparePrWorktreeOnce(ref: PullRequestRef, cloneUrl: string, headSha: string): Promise<string> {
    const startedAt = performance.now();
    const repoDir = repoDirForRef(ref);
    const worktreeDir = worktreeDirForRef(ref);
    const remoteRef = `refs/pi-pr-review/pr-${ref.number}`;
    logger.info("worktree", "prepare start", { repoDir, worktreeDir });
    await runtime.mkdir(resolve(repoDir, ".."));
    await runtime.mkdir(resolve(worktreeDir, ".."));
    if (!runtime.exists(resolve(repoDir, ".git"))) {
      await runtime.git(["clone", cloneUrl, repoDir]);
    }
    if (await currentWorktreeHead(worktreeDir) === headSha) {
      logger.info("worktree", "prepare skipped; existing worktree is current", { worktreeDir, ms: Math.round(performance.now() - startedAt) });
      return worktreeDir;
    }
    await gitAllowFailure(["worktree", "unlock", worktreeDir], repoDir);
    await gitAllowFailure(["worktree", "remove", "--force", worktreeDir], repoDir);
    await runtime.rm(worktreeDir);
    await runtime.git(["worktree", "prune"], repoDir);
    await runtime.git(["fetch", "--force", "origin", `pull/${ref.number}/head:${remoteRef}`], repoDir);
    await runtime.git(["worktree", "add", "--detach", "--force", worktreeDir, headSha], repoDir);
    logger.info("worktree", "prepare complete", { worktreeDir, ms: Math.round(performance.now() - startedAt) });
    return worktreeDir;
  }

  async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string): Promise<string> {
    const worktreeDir = worktreeDirForRef(ref);
    const previous = preparations.get(worktreeDir);
    const preparation = (previous == null ? Promise.resolve() : previous.then(() => undefined, () => undefined))
      .then(() => preparePrWorktreeOnce(ref, cloneUrl, headSha));
    preparations.set(worktreeDir, preparation);
    try {
      return await preparation;
    } finally {
      if (preparations.get(worktreeDir) === preparation) preparations.delete(worktreeDir);
    }
  }

  async function cleanupPrWorktree(ref: PullRequestRef): Promise<string> {
    const repoDir = repoDirForRef(ref);
    const worktreeDir = worktreeDirForRef(ref);
    if (runtime.exists(resolve(repoDir, ".git"))) {
      await gitAllowFailure(["worktree", "unlock", worktreeDir], repoDir);
      await gitAllowFailure(["worktree", "remove", "--force", worktreeDir], repoDir);
      await gitAllowFailure(["worktree", "prune"], repoDir);
    }
    await runtime.rm(worktreeDir);
    logger.info("worktree", "cleanup complete", { worktreeDir });
    return worktreeDir;
  }

  return { worktreeDirForRef, repoDirForRef, preparePrWorktree, cleanupPrWorktree };
}

const defaultService = createWorktreeService();

export function worktreeDirForRef(ref: PullRequestRef): string {
  return defaultService.worktreeDirForRef(ref);
}

export async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string): Promise<string> {
  return defaultService.preparePrWorktree(ref, cloneUrl, headSha);
}

export async function cleanupPrWorktree(ref: PullRequestRef): Promise<string> {
  return defaultService.cleanupPrWorktree(ref);
}
