import type { PullRequestRef } from "./types.js";

export type BlameInfo = {
  sha: string;
  author: string;
  authorTime: string;
  summary: string;
  prNumber: number | null;
  commitUrl: string;
};

export type BlameApiDeps = {
  exists: (path: string) => boolean;
  git: (args: string[], cwd: string) => Promise<string>;
  parsePullRequestRef: (input: string) => PullRequestRef;
  worktreeDirForRef: (ref: PullRequestRef) => string;
};

export type BlameApi = {
  blame: (payload: Record<string, unknown>) => Promise<{ blame: BlameInfo }>;
};

/** Parse `git blame --porcelain -L n,n` output into the commit facts the review UI shows. */
export function parseBlamePorcelain(output: string): Omit<BlameInfo, "commitUrl"> | null {
  const lines = output.split("\n");
  const sha = lines[0]?.split(" ")[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || /^0{40}$/.test(sha)) return null;
  let author = "";
  let authorTime = "";
  let summary = "";
  for (const line of lines.slice(1)) {
    if (line.startsWith("author ")) author = line.slice("author ".length);
    else if (line.startsWith("author-time ")) authorTime = new Date(Number(line.slice("author-time ".length)) * 1000).toISOString();
    else if (line.startsWith("summary ")) summary = line.slice("summary ".length);
    else if (line.startsWith("\t")) break;
  }
  const prNumber = summary.match(/\(#(\d+)\)\s*$/)?.[1];
  return { sha, author, authorTime, summary, prNumber: prNumber == null ? null : Number(prNumber) };
}

export function createBlameApi(deps: BlameApiDeps): BlameApi {
  async function blame(payload: Record<string, unknown>): Promise<{ blame: BlameInfo }> {
    const { prUrl, path, line } = payload;
    if (typeof prUrl !== "string" || prUrl.length === 0) throw new Error("Expected prUrl");
    if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.startsWith("-") || path.includes("..")) throw new Error("Expected a repository-relative path");
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw new Error("Expected a positive line number");
    const ref = deps.parsePullRequestRef(prUrl);
    const worktreeDir = deps.worktreeDirForRef(ref);
    if (!deps.exists(worktreeDir)) throw new Error("PR worktree is not prepared yet; open the PR first");
    const output = await deps.git(["blame", "--porcelain", "-L", `${line},${line}`, "HEAD", "--", path], worktreeDir);
    const parsed = parseBlamePorcelain(output);
    if (parsed == null) throw new Error(`No blame information for ${path}:${line}`);
    return { blame: { ...parsed, commitUrl: `https://${ref.host}/${ref.owner}/${ref.repo}/commit/${parsed.sha}` } };
  }

  return { blame };
}
