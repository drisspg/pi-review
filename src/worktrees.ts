import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { assertLegacyTransition, cacheGit, createCheckoutCache } from "./checkout-cache.js";
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
  /** Start fetching a PR head that has no checkout yet, so the fetch overlaps the GitHub API calls. Never throws. */
  prefetchPrHead: (ref: PullRequestRef) => Promise<void>;
  cleanupPrWorktree: (ref: PullRequestRef) => Promise<string>;
  deletePrWorktree: (ref: PullRequestRef) => Promise<string>;
  preservePublishedRevisions: (ref: PullRequestRef, isPublished: (sha: string) => Promise<boolean>) => Promise<{ preserved: number; unpublished: string[] }>;
  withPrWorktree: <T>(ref: PullRequestRef, operation: () => Promise<T>) => Promise<T>;
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
export function createWorktreeService(runtime: WorktreeRuntime = defaultRuntime, cacheRoot = checkoutCacheRoot(), deleteCheckout = createCheckoutCache(cacheRoot).deleteWorktree, now: () => number = Date.now): WorktreeService {
  const preparations = new Map<string, Promise<unknown>>();
  // PR heads fetched by prefetchPrHead, consumed by the next preparation of that PR.
  const prefetched = new Map<string, { head: string; at: number }>();
  const PREFETCH_TTL_MS = 60_000;
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
  /** Fetch the PR head into its pi-pr-review ref and return the fetched commit. */
  async function fetchPrHead(ref: PullRequestRef, repoDir: string): Promise<string> {
    const remoteRef = `refs/pi-pr-review/pr-${ref.number}`;
    const previousHead = await runtime.git(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`], repoDir).catch(() => "");
    await runtime.git(["fetch", "--force", "origin", `pull/${ref.number}/head:${remoteRef}`], repoDir);
    // A force-push replaces the PR ref; keep the previously fetched head under a revision ref so
    // the reviewed revision (still in the worktree's reflog) stays covered by fetched-PR evidence
    // and merged checkouts remain deletable.
    const fetchedHead = await runtime.git(["rev-parse", remoteRef], repoDir);
    if (/^[0-9a-f]{40}$/.test(previousHead) && previousHead !== fetchedHead) {
      await runtime.git(["update-ref", `${remoteRef}-rev-${previousHead.slice(0, 12)}`, previousHead], repoDir);
    }
    return fetchedHead;
  }

  /**
   * Only for a PR with no checkout in an existing clone: those opens always pay for a fetch, so
   * doing it while GitHub is answering saves its full duration. Existing checkouts are skipped
   * because a matching one needs no fetch at all.
   */
  async function prefetchPrHead(ref: PullRequestRef): Promise<void> {
    const repoDir = repoDirForRef(ref);
    const worktreeDir = worktreeDirForRef(ref);
    if (runtime.exists(worktreeDir) || !runtime.exists(resolve(repoDir, ".git"))) return;
    await transition(ref, async () => {
      if (runtime.exists(worktreeDir)) return;
      prefetched.set(worktreeDir, { head: await fetchPrHead(ref, repoDir), at: now() });
    }).catch((error: unknown) => {
      logger.info("worktree", "prefetch failed; preparation will fetch", { ref, error: error instanceof Error ? error.message : String(error) });
    });
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
      const early = prefetched.get(worktreeDir);
      prefetched.delete(worktreeDir);
      const fetchedHead = early != null && early.head === headSha && now() - early.at < PREFETCH_TTL_MS ? early.head : await fetchPrHead(ref, repoDir);
      if (mode === "reset" && fetchedHead !== headSha) {
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
  async function deletePrWorktree(ref: PullRequestRef): Promise<string> {
    return transition(ref, async () => {
      const worktreeDir = worktreeDirForRef(ref);
      await deleteCheckout(relative(cacheRoot, worktreeDir).split("\\").join("/"));
      return worktreeDir;
    });
  }
  /**
   * Re-fetch, from GitHub, reviewed revisions in this checkout's reflog that no fetched ref covers
   * (left behind by force-pushes before revision refs existed), so deletion can verify them.
   * Commits GitHub cannot serve are reported and left uncovered; deletion will then refuse.
   */
  async function preservePublishedRevisions(ref: PullRequestRef, isPublished: (sha: string) => Promise<boolean>): Promise<{ preserved: number; unpublished: string[] }> {
    return transition(ref, async () => {
      const worktreeDir = worktreeDirForRef(ref);
      const repoDir = repoDirForRef(ref);
      if (!runtime.exists(worktreeDir)) return { preserved: 0, unpublished: [] };
      const revisions = [...new Set([await runtime.git(["rev-parse", "HEAD"], worktreeDir), ...(await runtime.git(["reflog", "show", "--format=%H", "HEAD"], worktreeDir)).split("\n")].map((sha) => sha.trim()).filter((sha) => /^[0-9a-f]{40}$/.test(sha)))];
      let preserved = 0;
      const unpublished: string[] = [];
      for (const sha of revisions) {
        const uncovered = await runtime.git(["rev-list", "--max-count=1", sha, "--not", "--remotes=origin", "--glob=refs/pi-pr-review/*"], repoDir);
        if (uncovered.length === 0) continue;
        if (!(await isPublished(sha))) {
          unpublished.push(sha);
          continue;
        }
        await runtime.git(["fetch", "--quiet", "origin", `${sha}:refs/pi-pr-review/pr-${ref.number}-rev-${sha.slice(0, 12)}`], repoDir);
        preserved += 1;
      }
      return { preserved, unpublished };
    });
  }

  return { worktreeDirForRef, repoDirForRef, preparePrWorktree, prefetchPrHead, cleanupPrWorktree, deletePrWorktree, preservePublishedRevisions, withPrWorktree: transition };
}

const defaultService = createWorktreeService();
export const worktreeDirForRef = defaultService.worktreeDirForRef;
export const repoDirForRef = defaultService.repoDirForRef;
export async function preparePrWorktree(ref: PullRequestRef, cloneUrl: string, headSha: string, mode: "reuse" | "reset" = "reuse"): Promise<string> {
  await assertLegacyTransition();
  return defaultService.preparePrWorktree(ref, cloneUrl, headSha, mode);
}
export async function prefetchPrHead(ref: PullRequestRef): Promise<void> {
  // A blocked legacy cache makes the open itself fail with guidance; the prefetch just steps aside.
  if (await assertLegacyTransition().then(() => true, () => false)) await defaultService.prefetchPrHead(ref);
}
export const cleanupPrWorktree = defaultService.cleanupPrWorktree;
export const deletePrWorktree = defaultService.deletePrWorktree;
export const withPrWorktree = defaultService.withPrWorktree;
export const preservePublishedRevisions = defaultService.preservePublishedRevisions;
