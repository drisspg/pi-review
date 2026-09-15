import { homedir } from "node:os";
import { resolve } from "node:path";

export function legacyStorageRoot(home = homedir()): string {
  return resolve(home, ".pi", "agent", "state", "pi-pr-review");
}

export function reviewStatePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.PI_REVIEW_STATE_PATH == null ? resolve(legacyStorageRoot(home), "state.json") : resolve(env.PI_REVIEW_STATE_PATH);
}

export function usesDefaultReviewState(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  return reviewStatePath(env, home) === reviewStatePath({}, home);
}

/** Non-default state files also isolate checkouts and session records unless explicitly overridden. */
export function reviewSessionRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return usesDefaultReviewState(env, home) ? legacyStorageRoot(home) : `${reviewStatePath(env, home)}.data`;
}

export function checkoutCacheRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.PI_REVIEW_CACHE_DIR != null) {
    if (!env.PI_REVIEW_CACHE_DIR.trim()) throw new Error("PI_REVIEW_CACHE_DIR must not be empty");
    return resolve(env.PI_REVIEW_CACHE_DIR);
  }
  if (!usesDefaultReviewState(env, home)) return `${reviewStatePath(env, home)}.cache`;
  if (platform === "darwin") return resolve(home, "Library", "Caches", "pi-review");
  if (platform === "win32") return resolve(env.LOCALAPPDATA || resolve(home, "AppData", "Local"), "pi-review", "Cache");
  return resolve(env.XDG_CACHE_HOME || resolve(home, ".cache"), "pi-review");
}
