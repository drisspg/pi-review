import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { assertLegacyTransition, cacheGit } from "./checkout-cache.js";
import { logger } from "./logger.js";
import { checkoutCacheRoot } from "./storage-paths.js";
import type { PullRequestRef } from "./types.js";

type WorktreeRuntime = {
  exists: (path: string) => boolean;
  git: (args: string[], cwd?: string) => Promise<string>;
  mkdir: (path: string) => Promise<void>;
};

export type WorktreeService = {
  worktreeDirForRef: (ref: PullRequestRef) => string;
  repoDirForRef: (ref: PullRequestRef) => string;
  preparePrWorktree: (ref: PullRequestRef, cloneUrl: string, headSha: string) => Promise<string>;
  cleanupPrWorktree: (ref: PullRequestRef) => Promise<string>;
};

const defaultRuntime: WorktreeRuntime = {
  exists: existsSync,
  git: (args, cwd) => cacheGit(args, cwd ?? process.cwd()),
  async mkdir(path) { await mkdir(path, { recursive: true }); },
};

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** The server owns this cache for its entire lifetime; maintenance cannot run alongside it. */
export function createWorktreeService(runtime: WorktreeRuntime = defaultRuntime, cacheRoot = checkoutCacheRoot()): WorktreeService {
  const preparations = new Map<string, Promise<unknown>>();
  function worktreeDirForRef(ref: PullRequestRef): string {
    return resolve(cacheRoot, "worktrees", safe(ref.host), safe(ref.owner), safe(ref.repo), `pr-${ref.number}`);
  }
  function repoDirForRef(ref: PullRequestRef): string {
    return resolve(cacheRoot, "repos", safe(ref.host), safe(ref.owner), safe(ref.repo));
  }
  // Different PRs share a clone and its refs/worktree registry, so serialize by repository.
  function transition<T>(ref: PullRequestRef, operation: () => Promise<T>): Promise<T> {
    const key = repoDirForRef(ref);
    const pending = (preparations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    preparations.set(key, pending);
    void pending.finally(() => { if (preparations.get(key) === pending) preparations.delete(key); }).catch(() => undefined);
    return pending;
  }
  function maintenanceRequired(path: string): Error {
    return new Error(`Checkout retained at ${path}. Inspect and evict it with npm run cache during offline maintenance before replacing/removing it. No user files or review state were deleted.`);
  }
  async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string): Promise<string> {
    return transition(ref, async () => {
      const repoDir = repoDirForRef(ref);
      const worktreeDir = worktreeDirForRef(ref);
      if (runtime.exists(worktreeDir)) {
        // Errors (including an interrupted checkout) are not permission to force-delete.
        const head = await runtime.git(["rev-parse", "HEAD"], worktreeDir);
        const index = resolve(worktreeDir, await runtime.git(["rev-parse", "--git-path", "index"], worktreeDir));
        if (head !== headSha || !runtime.exists(index)) throw maintenanceRequired(worktreeDir);
        return worktreeDir;
      }
      await runtime.mkdir(resolve(repoDir, ".."));
      await runtime.mkdir(resolve(worktreeDir, ".."));
      if (!runtime.exists(repoDir)) await runtime.git(["clone", cloneUrl, repoDir]);
      else if (!runtime.exists(resolve(repoDir, ".git"))) throw maintenanceRequired(repoDir);
      const remoteRef = `refs/pi-pr-review/pr-${ref.number}`;
      await runtime.git(["fetch", "--force", "origin", `pull/${ref.number}/head:${remoteRef}`], repoDir);
      // No --force/prune/unlock: stale registrations and ambiguous states need inspection.
      await runtime.git(["worktree", "add", "--detach", worktreeDir, headSha], repoDir);
      logger.info("worktree", "prepare complete", { worktreeDir });
      return worktreeDir;
    });
  }
  async function cleanupPrWorktree(ref: PullRequestRef): Promise<string> {
    return transition(ref, async () => {
      const worktreeDir = worktreeDirForRef(ref);
      if (runtime.exists(worktreeDir)) throw maintenanceRequired(worktreeDir);
      return worktreeDir;
    });
  }
  return { worktreeDirForRef, repoDirForRef, preparePrWorktree, cleanupPrWorktree };
}

const defaultService = createWorktreeService();
export const worktreeDirForRef = defaultService.worktreeDirForRef;
export const repoDirForRef = defaultService.repoDirForRef;
export async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string): Promise<string> {
  await assertLegacyTransition();
  return defaultService.preparePrWorktree(ref, cloneUrl, headSha);
}
export const cleanupPrWorktree = defaultService.cleanupPrWorktree;
