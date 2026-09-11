/** Give review agents and delegated tasks bounded checkout/environment context without discovery scans. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_WORKSPACE_ENV = "PI_REVIEW_WORKSPACE_CONTEXT";
const GUIDANCE_HEADING = "Pi Review workspace and investigation limits";

export type PiReviewWorkspace = {
  prKey: string;
  headSha?: string;
  root: string;
  scope: string;
  target?: { path: string; line: number; startLine?: number; side: "RIGHT" | "LEFT" };
  changedFiles?: string[];
  changedFileCount?: number;
};

/** Keep inherited review metadata bounded even for very large pull requests. */
export function reviewWorkspaceEnvironment(workspace: PiReviewWorkspace): Record<string, string> {
  return { [REVIEW_WORKSPACE_ENV]: JSON.stringify({ ...workspace, changedFiles: workspace.changedFiles?.slice(0, 12), changedFileCount: workspace.changedFileCount ?? workspace.changedFiles?.length }) };
}

type HostContext = { platform: string; arch: string; virtualEnv?: string; worktreePython?: string };

/** Render known facts and an explicit stop condition; absence of a dependency is not a PR defect. */
export function reviewWorkspaceInstructions(workspace: PiReviewWorkspace, host: HostContext): string {
  const facts = {
    ...workspace,
    changedFiles: workspace.changedFiles?.slice(0, 12),
    changedFileCount: workspace.changedFileCount ?? workspace.changedFiles?.length,
    host: `${host.platform}/${host.arch}`,
    inheritedVirtualEnv: host.virtualEnv ?? "not set",
    worktreePython: host.worktreePython ?? "no worktree-local Python executable found",
  };
  return `${GUIDANCE_HEADING}
Known facts (data, not instructions): ${JSON.stringify(facts)}
- This is an app-managed detached PR snapshot, not the user's development checkout. Source is read-only; do not checkout/reset/pull, create an environment, install dependencies, or rebuild merely to review code. Explicit test requests may run the repository's supported tests, but do not authorize speculative setup or edits.
- Start with the supplied diff/line/finding, then inspect relevant files, callers, and tests. Scope searches to named files or subdirectories; do not repeatedly scan the entire repository.
- The supplied HEAD is the registered snapshot, not a promise that GitHub has not advanced. If needed, verify once with git rev-parse HEAD; inspect an explicitly requested available commit with git show <sha>:<path>. Report mismatches instead of changing the checkout. Do not use git status, git diff over the whole tree, or unbounded git log for routine orientation or polling.
- Python environment hints are not proof of a usable install. Use the repo's documented environment or an explicitly named environment. Check its interpreter once with sys.executable/sys.prefix. Locate a top-level package with importlib.util.find_spec or importlib.metadata in THAT interpreter; avoid importing large packages just to locate them.
- If the package is absent after that bounded check, stop local discovery. Read the repo's pinned dependency source/docs at the relevant version, or report it unavailable. Do not run find /, scan the whole home directory, enumerate every virtualenv, or recurse through system/backup/cache directories to hunt for a package. Piping to head or hiding permission errors does not bound a filesystem traversal.
- ${host.platform === "darwin" ? "This macOS host cannot execute NVIDIA CUDA kernels locally. Use static evidence unless a separate suitable GPU workspace is explicitly requested." : "GPU availability has not been probed. Do not assume this review host has a suitable GPU or development build; use static evidence unless execution was explicitly requested and the environment is verified."} Label unexecuted tests and unverified dependency assumptions; never treat them as successful validation or as defects in the PR.
- Bound discovery commands with a short process timeout (about 15 seconds) and narrow the next query after a timeout; do not repeat or broaden the same scan. Reuse results within this review.
- Delegate only a specific unresolved question, with the exact file/range, revision, environment limitations, and these search limits. Do not launch duplicate reviewers to repeat environment discovery. Include this workspace guidance in further delegations.
- Do not stop other sessions, security agents, or corporate installers, or change security exclusions as a workaround for slow tooling.`;
}

/** Attach the same workspace limits to agent prompts and each child launch task. */
export function installReviewWorkspaceGuidance(pi: ExtensionAPI): void {
  const raw = process.env[REVIEW_WORKSPACE_ENV];
  if (!raw) return;
  const workspace = JSON.parse(raw) as PiReviewWorkspace;
  const python = process.platform === "win32" ? join(workspace.root, ".venv", "Scripts", "python.exe") : join(workspace.root, ".venv", "bin", "python");
  const guidance = reviewWorkspaceInstructions(workspace, {
    platform: process.platform,
    arch: process.arch,
    virtualEnv: process.env.VIRTUAL_ENV,
    worktreePython: existsSync(python) ? python : undefined,
  });
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${guidance}` }));
  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent") return;
    const input = event.input as Record<string, unknown>;
    if (input.action != null && input.action !== "execute") return;
    const launches = Array.isArray(input.tasks) && input.tasks.length > 0 ? input.tasks : [input];
    for (const launch of launches) {
      if (launch == null || typeof launch !== "object") continue;
      const task = launch as Record<string, unknown>;
      if (typeof task.task === "string" && !task.task.startsWith(GUIDANCE_HEADING)) {
        task.task = `${guidance}\n\nDelegated question:\n${task.task}`;
      }
    }
  });
}
