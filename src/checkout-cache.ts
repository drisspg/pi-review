import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { checkoutCacheRoot, legacyStorageRoot, usesDefaultReviewState } from "./storage-paths.js";

const exec = promisify(execFile);
const owners = new Map<string, string>();
export const CACHE_LOCK = ".checkout-owner";
export type CacheEntry = { id: string; path: string; kind: "worktree" | "repo"; reasons: string[] };
export type CacheRuntime = {
  git: (args: string[], cwd: string) => Promise<string>;
  users: (root: string) => Promise<string[]>;
};

export async function cacheGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: ["clone", "fetch"].includes(args[0]) ? 300_000 : 60_000, maxBuffer: 50 * 1024 * 1024,
  });
  return stdout.trim();
}

/** No stale-owner stealing: a crash requires explicit operator recovery after checking processes. */
export function ownCheckoutCache(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const lock = resolve(realpathSync(root), CACHE_LOCK);
  try { mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Checkout cache is owned or needs manual lock recovery: ${lock}. Stop its server before maintenance; never remove a live owner's lock.`);
  }
  const ownerPath = resolve(lock, "owner.json");
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token: randomUUID() });
  writeFileSync(ownerPath, owner);
  owners.set(lock, owner);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    if (owners.get(lock) === owner) owners.delete(lock);
    try {
      if (readFileSync(ownerPath, "utf8") === owner) rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  process.once("exit", release);
  return release;
}

/** lsof is supplementary: offline maintenance also requires the operator to close external users. */
export async function checkoutUsers(root: string, ignoredServerPids = [process.pid]): Promise<string[]> {
  const canonical = await realpath(root);
  const { stdout, stderr } = await exec("lsof", ["-n", "-P", "-u", String(process.getuid?.() ?? ""), "-Fpn"], { timeout: 15_000, maxBuffer: 30 * 1024 * 1024 });
  if (stderr.trim()) throw new Error("Process inspection was incomplete (lsof warnings); close checkout users and investigate before eviction.");
  const users = new Set<string>();
  let pid = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    if (line.startsWith("n") && (line.slice(1) === canonical || line.slice(1).startsWith(`${canonical}${sep}`))) {
      const parts = relative(canonical, line.slice(1)).split(sep);
      const location = parts.slice(0, parts[0] === "worktrees" ? 5 : parts[0] === "repos" ? 4 : 2).join("/");
      users.add(`process ${pid} has an open path in ${location || "this cache"}`);
    }
  }
  // Old releases do not participate in the cache lock. Block legacy maintenance while any
  // server is present, even if it currently has no open file descriptors in a checkout.
  if (canonical === await realpath(legacyStorageRoot()).catch(() => "")) {
    const { stdout: processes } = await exec("ps", ["-axo", "pid=,command="], { timeout: 10_000 });
    for (const line of processes.split("\n")) {
      const pid = Number(line.trim().split(/\s/)[0]);
      if (!ignoredServerPids.includes(pid) && /\b(?:node|tsx|bun)\b.*(?:dist-server\/server\.js|src\/server\.ts)(?:\s|$)/.test(line)) users.add(`legacy storage may be used by server PID ${pid}`);
    }
  }
  return [...users];
}

export async function ownServerCheckoutCache(root: string): Promise<() => void> {
  const release = ownCheckoutCache(root);
  try {
    // Older servers never take this lock and always use the legacy location.
    if (await realpath(root) === await realpath(legacyStorageRoot()).catch(() => "")) {
      const users = await checkoutUsers(root, [process.pid, process.ppid]);
      if (users.length) throw new Error(`Legacy checkout storage is still in use: ${users.join("; ")}`);
    }
    return release;
  } catch (error) { release(); throw error; }
}

const defaultRuntime: CacheRuntime = { git: cacheGit, users: checkoutUsers };

async function children(path: string): Promise<string[]> {
  try { return await readdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Walk only the fixed host/owner/repo[/PR] layout, never repository source trees. */
async function entriesAt(root: string, kind: CacheEntry["kind"]): Promise<CacheEntry[]> {
  let paths = [kind === "repo" ? "repos" : "worktrees"];
  const unexpected: CacheEntry[] = [];
  for (let depth = 0; depth < (kind === "repo" ? 3 : 4); depth++) {
    const next: string[] = [];
    for (const path of paths) {
      const absolute = resolve(root, path);
      if (existsSync(absolute) && !(await lstat(absolute)).isDirectory()) {
        unexpected.push({ id: path, path: absolute, kind, reasons: ["unexpected cache layout; manual handling required"] });
        continue;
      }
      for (const name of await children(absolute)) {
        if (name === ".DS_Store" && (await lstat(resolve(absolute, name))).isFile()) continue;
        next.push(`${path}/${name}`);
      }
    }
    paths = next;
  }
  return [...unexpected, ...paths.map((id) => ({ id, path: resolve(root, id), kind, reasons: [] }))];
}

async function assertContained(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Path is outside checkout storage");
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlinked checkout paths require manual handling");
  }
}

async function inspectEntry(root: string, entry: CacheEntry, runtime: CacheRuntime): Promise<void> {
  if (entry.reasons.length) return;
  try {
    // Canonicalize the root only; inner symlinks remain visible to containment checks.
    const canonicalRoot = await realpath(root);
    const path = resolve(canonicalRoot, relative(root, entry.path));
    root = canonicalRoot;
    await assertContained(root, path);
    const git = (args: string[]) => runtime.git(args, path);
    const canonical = await realpath(path);
    if (await realpath(await git(["rev-parse", "--show-toplevel"])) !== canonical) throw new Error("Not a checkout root");
    const common = await realpath(resolve(path, await git(["rev-parse", "--git-common-dir"])));
    const repoPath = entry.kind === "repo" ? path : resolve(root, "repos", ...entry.id.split("/").slice(1, 4));
    await assertContained(root, resolve(repoPath, ".git"));
    if (common !== await realpath(resolve(repoPath, ".git"))) throw new Error("Git linkage points outside its expected cache clone");
    const gitDir = resolve(path, await git(["rev-parse", "--absolute-git-dir"]));
    await assertContained(root, gitDir);
    if (entry.kind === "worktree") {
      const allowed = new Set(["HEAD", "commondir", "gitdir", "index", "logs", "refs", "ORIG_HEAD", "FETCH_HEAD"]);
      if ((await children(gitDir)).some((name) => !allowed.has(name)) || (await children(resolve(gitDir, "logs"))).some((name) => name !== "HEAD") || (await children(resolve(gitDir, "refs"))).length) entry.reasons.push("worktree-specific Git state needs manual preservation");
    }
    const index = resolve(path, await git(["rev-parse", "--git-path", "index"]));
    if (!existsSync(index)) throw new Error("Missing Git index");
    if (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"])) entry.reasons.push("tracked, staged, untracked, or ignored files need preservation");
    if ((await git(["ls-files", "-v"])).split("\n").some((line) => line && !line.startsWith("H "))) entry.reasons.push("index has assume-unchanged/skip-worktree or unusual entries");
    for (const line of (await git(["ls-files", "--stage"])).split("\n")) {
      if (!line.startsWith("160000 ")) continue;
      const submodule = line.split("\t")[1];
      if (!submodule || submodule.startsWith('"') || (await children(resolve(path, submodule))).length) {
        entry.reasons.push("populated or ambiguous submodules require manual handling");
        break;
      }
    }
    const worktrees = await git(["worktree", "list", "--porcelain"]);
    const record = worktrees.split("\n\n").find((item) => item.split("\n")[0] === `worktree ${canonical}`);
    if (!record || /\n(?:locked|prunable)(?:\s|$)/m.test(record)) entry.reasons.push("missing, locked, or prunable Git worktree registration");
    // Remote-tracking and fetched PR refs are the only accepted preservation evidence.
    // Include reflogs: resetting a detached local commit must not hide it from inspection.
    const revisions = entry.kind === "repo" ? ["HEAD", "--all", "--reflog"] : ["HEAD", ...(await git(["reflog", "show", "--format=%H", "HEAD"])).split("\n").filter(Boolean)];
    if (await git(["rev-list", "--max-count=1", ...revisions, "--not", "--remotes=origin", "--glob=refs/pi-pr-review/*"])) entry.reasons.push("local commits/refs/reflogs are not covered by fetched origin or PR refs");
    if (entry.kind === "repo") {
      if (worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length !== 1) entry.reasons.push("clone still has linked worktrees; evict those first");
      if (await git(["for-each-ref", "--format=%(refname)", "refs/tags/", "refs/notes/", "refs/stash", "refs/replace/"])) entry.reasons.push("tags/notes/stashes/replace refs require manual preservation; remote publication is not verified");
      const config = await git(["config", "--local", "--name-only", "--list"]);
      if (config.split("\n").some((key) => !/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(url|fetch)|branch\.[^.]+\.(remote|merge))$/.test(key))) entry.reasons.push("custom local Git configuration needs manual handling");
      if ((await children(resolve(common, "hooks"))).some((name) => !name.endsWith(".sample"))) entry.reasons.push("custom Git hooks need preservation");
      const info = await readFile(resolve(common, "info", "exclude"), "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      if (info.split("\n").some((line) => line.trim() && !line.trim().startsWith("#"))) entry.reasons.push("custom Git excludes need preservation");
      const allowed = new Set(["HEAD", "config", "description", "hooks", "info", "objects", "refs", "logs", "packed-refs", "index", "FETCH_HEAD", "ORIG_HEAD", "worktrees", "shallow"]);
      if ((await children(common)).some((name) => !allowed.has(name)) || (await children(resolve(common, "info"))).some((name) => !["exclude", "refs", "commit-graph", "packs"].includes(name))) entry.reasons.push("additional Git administrative data needs manual handling");
      // Walking a large object database is expensive; only do it for an otherwise eligible clone.
      if (!entry.reasons.length && (await git(["fsck", "--full", "--unreachable", "--no-reflogs"])).trim()) entry.reasons.push("unreachable Git objects need manual preservation");
    }
  } catch (error) {
    entry.reasons.push(`inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createCheckoutCache(root: string, runtime: CacheRuntime = defaultRuntime) {
  root = resolve(root);
  async function inventory(): Promise<{ root: string; blockers: string[]; entries: CacheEntry[] }> {
    if (!existsSync(root)) return { root, blockers: [], entries: [] };
    const blockers: string[] = [];
    if (existsSync(resolve(root, CACHE_LOCK))) blockers.push(`cache owner lock exists: ${resolve(root, CACHE_LOCK)}`);
    try { blockers.push(...await runtime.users(root)); } catch (error) { blockers.push(`process inspection failed: ${error instanceof Error ? error.message : String(error)}`); }
    const entries = [...await entriesAt(root, "worktree"), ...await entriesAt(root, "repo")];
    for (const entry of entries) {
      await inspectEntry(root, entry, runtime);
      entry.reasons.push(...blockers.filter((reason) => reason.endsWith(`in ${entry.id}`)));
    }
    return { root, blockers, entries };
  }

  /** Server-owned deletion shares the offline safety checks; callers must drain PR consumers. */
  async function deleteWorktree(id: string): Promise<void> {
    const lock = resolve(await realpath(root), CACHE_LOCK);
    function assertOwned(): void {
      const owner = owners.get(lock);
      let recorded: string;
      try { recorded = readFileSync(resolve(lock, "owner.json"), "utf8"); } catch (error) {
        throw new Error("Checkout deletion requires this process to own the cache", { cause: error });
      }
      if (owner == null || recorded !== owner) throw new Error("Checkout deletion requires this process to own the cache");
    }
    assertOwned();
    if (!/^worktrees\/[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+\/pr-\d+$/.test(id) || id.split("/").includes("..")) throw new Error("Invalid worktree ID");
    const entry: CacheEntry = { id, path: resolve(root, id), kind: "worktree", reasons: [] };
    const repo = resolve(root, "repos", ...id.split("/").slice(1, 4));
    try { await lstat(entry.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (existsSync(repo)) {
        const expected = resolve(await realpath(root), id);
        const registrations = await runtime.git(["worktree", "list", "--porcelain"], repo);
        if (registrations.split("\n").includes(`worktree ${expected}`)) throw new Error("Missing checkout still has a Git registration; inspect it during offline maintenance before reopening");
      }
      return;
    }
    await inspectEntry(root, entry, runtime);
    if (entry.reasons.length) throw new Error(`Checkout protected: ${entry.reasons.join("; ")}. No checkout files or saved reviews were deleted.`);
    const users = await runtime.users(entry.path);
    if (users.length) throw new Error(`Close external checkout users before deleting: ${users.join("; ")}`);
    assertOwned();
    await runtime.git(["worktree", "remove", entry.path], repo);
  }

  /** CLI maintenance remains offline-only, including full-clone deletion. */
  async function evict(id: string, offlineConfirmed: boolean): Promise<void> {
    if (!offlineConfirmed) throw new Error("Confirm offline maintenance: stop the owning server and close terminals/editors/jobs using this cache first");
    const release = ownCheckoutCache(root);
    try {
      const users = await runtime.users(root);
      if (users.length) throw new Error(users.join("; "));
      const entries = [...await entriesAt(root, "worktree"), ...await entriesAt(root, "repo")];
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error("Unknown checkout ID; run inventory first");
      await inspectEntry(root, entry, runtime);
      if (entry.reasons.length) throw new Error(`Refusing eviction of ${id}: ${entry.reasons.join("; ")}`);
      if (entry.kind === "worktree") {
        const repo = resolve(root, "repos", ...id.split("/").slice(1, 4));
        await runtime.git(["worktree", "remove", entry.path], repo);
      } else {
        await rm(entry.path, { recursive: true });
      }
    } finally { release(); }
  }
  return { inventory, evict, deleteWorktree };
}

/** A new default must not silently strand old clones and create a duplicate set. */
export async function assertLegacyTransition(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<void> {
  if (!usesDefaultReviewState(env, home) || env.PI_REVIEW_CACHE_DIR != null) return;
  const root = legacyStorageRoot(home);
  if ((await entriesAt(root, "repo")).length || (await entriesAt(root, "worktree")).length) {
    throw new Error(`Legacy checkouts remain at ${root}. Run npm run cache -- inventory --legacy. Evict safe entries offline before using ${checkoutCacheRoot(env, process.platform, home)}, or explicitly set PI_REVIEW_CACHE_DIR=${root} to keep using legacy storage. Review state stays in place.`);
  }
}
