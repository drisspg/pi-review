import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { assertLegacyTransition, cacheGit } from "./checkout-cache.js";
import { logger } from "./logger.js";
import { checkoutCacheRoot } from "./storage-paths.js";
import type { PullRequestRef } from "./types.js";

export class CheckoutResetRequiredError extends Error {
  readonly code = "CHECKOUT_RESET_REQUIRED";

  constructor(worktreeDir: string) {
    super(`This checkout is on an older or local revision. Use Refresh to reset it to the remote PR: ${worktreeDir}`);
  }
}

type WorktreeRuntime = {
  exists: (path: string) => boolean;
  realpath: (path: string) => Promise<string>;
  git: (args: string[], cwd?: string) => Promise<string>;
  mkdir: (path: string) => Promise<void>;
};

export type WorktreeService = {
  worktreeDirForRef: (ref: PullRequestRef) => string;
  repoDirForRef: (ref: PullRequestRef) => string;
  preparePrWorktree: (ref: PullRequestRef, cloneUrl: string, headSha: string, mode?: "reuse" | "reset") => Promise<string>;
  cleanupPrWorktree: (ref: PullRequestRef) => Promise<string>;
};

const defaultRuntime: WorktreeRuntime = {
  exists: existsSync,
  realpath,
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
  async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string, mode: "reuse" | "reset" = "reuse"): Promise<string> {
    return transition(ref, async () => {
      const repoDir = repoDirForRef(ref);
      const worktreeDir = worktreeDirForRef(ref);
      const existing = runtime.exists(worktreeDir);
      if (existing) {
        // Interrupted or foreign checkouts still require manual inspection, even on Refresh.
        const head = await runtime.git(["rev-parse", "HEAD"], worktreeDir);
        const index = resolve(worktreeDir, await runtime.git(["rev-parse", "--git-path", "index"], worktreeDir));
        if (!runtime.exists(index)) throw maintenanceRequired(worktreeDir);
        if (mode === "reuse") {
          if (head !== headSha) throw new CheckoutResetRequiredError(worktreeDir);
          return worktreeDir;
        }
        // Canonicalize only the cache root (e.g. macOS /var -> /private/var), not inner symlinks.
        const canonicalRoot = await runtime.realpath(cacheRoot);
        const expectedWorktree = resolve(canonicalRoot, relative(cacheRoot, worktreeDir));
        const expectedCommon = resolve(canonicalRoot, relative(cacheRoot, repoDir), ".git");
        const topLevel = await runtime.git(["rev-parse", "--show-toplevel"], worktreeDir);
        const commonDir = resolve(expectedWorktree, await runtime.git(["rev-parse", "--git-common-dir"], worktreeDir));
        const worktrees = await runtime.git(["worktree", "list", "--porcelain"], repoDir);
        const record = worktrees.split("\n\n").find((item) => item.split("\n")[0] === `worktree ${expectedWorktree}`);
        if (topLevel !== expectedWorktree || commonDir !== expectedCommon || !record || /\n(?:locked|prunable)(?:\s|$)/m.test(record)) throw maintenanceRequired(worktreeDir);
        const submodules = await runtime.git(["submodule", "status"], worktreeDir);
        if (submodules.split("\n").some((line) => line && !line.startsWith("-"))) throw maintenanceRequired(worktreeDir);
        for (const state of ["rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
          if (runtime.exists(resolve(worktreeDir, await runtime.git(["rev-parse", "--git-path", state], worktreeDir)))) throw maintenanceRequired(worktreeDir);
        }
      }
      await runtime.mkdir(resolve(repoDir, ".."));
      await runtime.mkdir(resolve(worktreeDir, ".."));
      if (!runtime.exists(repoDir)) await runtime.git(["clone", cloneUrl, repoDir]);
      else if (!runtime.exists(resolve(repoDir, ".git"))) throw maintenanceRequired(repoDir);
      const remoteRef = `refs/pi-pr-review/pr-${ref.number}`;
      await runtime.git(["fetch", "--force", "origin", `pull/${ref.number}/head:${remoteRef}`], repoDir);
      if (mode === "reset" && await runtime.git(["rev-parse", remoteRef], repoDir) !== headSha) {
        throw new Error("The remote PR changed while refreshing. Try Refresh again; the checkout has not been reset.");
      }
      if (existing) {
        // Detach rather than moving a user's local branch. Keep ignored environments/build caches.
        await runtime.git(["checkout", "--detach", "--force", headSha], worktreeDir);
        await runtime.git(["clean", "-fd"], worktreeDir);
      } else {
        // No --force/prune/unlock: stale registrations need inspection, not replacement.
        await runtime.git(["worktree", "add", "--detach", worktreeDir, headSha], repoDir);
      }
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
export async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string, mode: "reuse" | "reset" = "reuse"): Promise<string> {
  await assertLegacyTransition();
  return defaultService.preparePrWorktree(ref, cloneUrl, headSha, mode);
}
export const cleanupPrWorktree = defaultService.cleanupPrWorktree;
