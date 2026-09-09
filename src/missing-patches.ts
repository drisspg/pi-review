/** Recover omitted GitHub patches from immutable commits, before UI and agent consumers diverge. */
import { fileFingerprint } from "./file-fingerprint.js";
import { safeDiffPath } from "./interdiff-git.js";
import type { PullRequestReviewData } from "./types.js";

export type MissingPatchDeps = {
  git: (args: string[], cwd: string) => Promise<string>;
  warn: (message: string, details: Record<string, unknown>) => void;
};

/** Preserve the cached GitHub snapshot; enrich only missing patches using the PR merge base. */
export function createMissingPatchRecovery(deps: MissingPatchDeps) {
  return async function recoverMissingPatches(data: PullRequestReviewData, cwd: string): Promise<PullRequestReviewData> {
    const missing = data.files.filter((file) => !file.patch?.trim());
    if (missing.length === 0) return data;
    const { baseSha, headSha } = data.pr;
    let mergeBase: string;
    try {
      if (![baseSha, headSha].every((sha) => /^[0-9a-f]{40}$/i.test(sha))) throw new Error("Expected pinned base and head commit SHAs");
      await deps.git(["cat-file", "-e", `${baseSha}^{commit}`], cwd).catch(async () => {
        await deps.git(["fetch", "--quiet", "--no-tags", "origin", baseSha], cwd);
      });
      mergeBase = (await deps.git(["merge-base", baseSha, headSha], cwd)).trim();
      if (!/^[0-9a-f]{40}$/i.test(mergeBase)) throw new Error("Could not identify the PR merge base");
    } catch (error) {
      deps.warn("Could not recover missing PR patches", { prKey: data.pr.key, error: String(error) });
      return data;
    }

    const recovered = new Map<string, string>();
    // Serial reads avoid a process burst when GitHub omits many files in a large PR.
    for (const file of missing) {
      try {
        if (!safeDiffPath(file.filename) || (file.previous_filename != null && !safeDiffPath(file.previous_filename))) throw new Error("Unsafe diff path");
        const revisions = file.status === "renamed" && file.previous_filename != null
          ? [`${mergeBase}:${file.previous_filename}`, `${headSha}:${file.filename}`]
          : [mergeBase, headSha, "--", `:(literal)${file.filename}`];
        const diff = await deps.git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", ...revisions], cwd);
        const hunk = diff.search(/^@@ /m);
        // Binary, mode-only and unchanged renames legitimately have no textual hunks.
        if (hunk !== -1) recovered.set(file.filename, diff.slice(hunk).replace(/\n$/, ""));
      } catch (error) {
        deps.warn("Could not recover file patch", { prKey: data.pr.key, path: file.filename, error: String(error) });
      }
    }
    if (recovered.size === 0) return data;
    const files = data.files.map((file) => recovered.has(file.filename) ? { ...file, patch: recovered.get(file.filename)! } : file);
    const fingerprints = new Map(files.filter((file) => recovered.has(file.filename)).map((file) => [file.filename, fileFingerprint(file)]));
    return {
      ...data,
      files,
      fileReviews: data.fileReviews.map((review) => fingerprints.has(review.path) ? { ...review, fingerprint: fingerprints.get(review.path)!, viewed: false } : review),
    };
  };
}
