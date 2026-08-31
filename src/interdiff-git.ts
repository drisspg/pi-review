/**
 * Local-git engine for "changes since my last review".
 *
 * Appended commits are a plain two-dot diff. Rewritten history (ghstack,
 * stack-pr, rebases) is the hard case: comparing the two heads directly — or
 * GitHub's three-dot compare — reports every upstream commit the rebase pulled
 * in. Instead we compare each file's *own* patch (its added/removed lines) in
 * the old PR diff vs the current one, and surface only files whose change
 * actually changed.
 */

import type { PullFile, PullRequestRef } from "./types.js";

export type GitInterdiffDeps = {
  exists: (path: string) => boolean;
  git: (args: string[], cwd: string) => Promise<string>;
  repoDirForRef: (ref: PullRequestRef) => string;
};

function fileStatus(header: string): { status: string; previousFilename?: string } {
  const rename = header.match(/^rename from (.+)$/m);
  if (rename != null) return { status: "renamed", previousFilename: rename[1] };
  if (/^new file mode /m.test(header)) return { status: "added" };
  if (/^deleted file mode /m.test(header)) return { status: "removed" };
  return { status: "modified" };
}

function fileName(header: string): string | null {
  // `+++ b/<path>` is authoritative except for deletions, where it is /dev/null.
  const added = header.match(/^\+\+\+ b\/(.+)$/m);
  if (added != null) return added[1];
  const removed = header.match(/^--- a\/(.+)$/m);
  if (removed != null) return removed[1];
  // Binary or mode-only changes carry paths only on the `diff --git` line.
  const gitLine = header.match(/^diff --git a\/(.+) b\/(.+)$/m);
  return gitLine?.[2] ?? null;
}

/** Parse `git diff` output into the GitHub files-API shape the diff UI renders. */
export function parseGitDiffFiles(output: string): PullFile[] {
  const files: PullFile[] = [];
  const sections = output.split(/^(?=diff --git )/m).filter((section) => section.startsWith("diff --git "));
  for (const section of sections) {
    const hunkStart = section.search(/^@@/m);
    const header = hunkStart === -1 ? section : section.slice(0, hunkStart);
    const filename = fileName(header);
    if (filename == null) continue;
    const patch = hunkStart === -1 ? undefined : section.slice(hunkStart).replace(/\n$/, "");
    let additions = 0;
    let deletions = 0;
    for (const line of patch?.split("\n") ?? []) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const { status, previousFilename } = fileStatus(header);
    files.push({ filename, status, additions, deletions, changes: additions + deletions, ...(patch == null ? {} : { patch }), ...(previousFilename == null ? {} : { previous_filename: previousFilename }) });
  }
  return files;
}

export function safeDiffPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 1_000 && !path.startsWith("/") && !path.startsWith("-") && !path.includes("..") && !path.includes("\0");
}

/** A file's change identity: its added/removed lines, independent of hunk offsets and context drift. */
export function patchSignature(patch: string | undefined): string {
  if (patch == null) return "";
  return patch.split("\n").filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))).join("\n");
}

export type GitInterdiffResult = { files: PullFile[]; totalCommits: number; rewritten: boolean };

export function createGitInterdiff(deps: GitInterdiffDeps) {
  return async function gitInterdiff(ref: PullRequestRef, sinceSha: string, headSha: string, currentFiles: PullFile[]): Promise<GitInterdiffResult> {
    const repoDir = deps.repoDirForRef(ref);
    if (!deps.exists(repoDir)) throw new Error("No cached repository for this pull request");
    await deps.git(["cat-file", "-e", `${sinceSha}^{commit}`], repoDir).catch(async () => {
      // Some hosts still serve force-pushed commits by SHA even when compare 404s.
      await deps.git(["fetch", "--quiet", "origin", sinceSha], repoDir).catch(() => undefined);
      await deps.git(["cat-file", "-e", `${sinceSha}^{commit}`], repoDir).catch(() => {
        throw new Error(`Commit ${sinceSha.slice(0, 12)} is no longer available locally or upstream`);
      });
    });

    const appended = await deps.git(["merge-base", "--is-ancestor", sinceSha, headSha], repoDir).then(() => true, () => false);
    if (appended) {
      const [diff, count] = await Promise.all([
        deps.git(["diff", "--no-color", "--find-renames", sinceSha, headSha], repoDir),
        deps.git(["rev-list", "--count", `${sinceSha}..${headSha}`], repoDir).catch(() => "0"),
      ]);
      return { files: parseGitDiffFiles(diff), totalCommits: Number.parseInt(count.trim(), 10) || 0, rewritten: false };
    }

    // Rewritten history: reconstruct the old PR diff from its fork point and
    // keep only current files whose own patch differs from the old one.
    const oldDiff = await deps.git(["merge-base", sinceSha, headSha], repoDir)
      .then((oldBase) => deps.git(["diff", "--no-color", "--find-renames", oldBase.trim(), sinceSha], repoDir))
      .catch(() => null);
    if (oldDiff == null) return { files: currentFiles, totalCommits: 0, rewritten: true };
    const oldSignatures = new Map(parseGitDiffFiles(oldDiff).map((file) => [file.filename, patchSignature(file.patch)]));
    const files = currentFiles.filter((file) => oldSignatures.get(file.filename) !== patchSignature(file.patch));
    return { files, totalCommits: 0, rewritten: true };
  };
}
