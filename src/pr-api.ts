import { safeDiffPath, type GitInterdiffResult } from "./interdiff-git.js";
import { parsePullRequestRef, prKey } from "./pr.js";
import type { AiReviewRecord, CommitChecks, DraftReview, FocusScanRecord, GuideReviewRecord, PullFile, PullRequestRef, PullRequestReviewData, PullRequestReviewResponse, StoredPullRequest } from "./types.js";

export type PrApiDeps = {
  cleanupPrWorktree: (ref: PullRequestRef) => Promise<string>;
  compareCommits: (ref: PullRequestRef, baseSha: string, headSha: string) => Promise<{ files: PullFile[]; totalCommits: number }>;
  compareCommitsLocally: (ref: PullRequestRef, sinceSha: string, headSha: string, currentFiles: PullFile[]) => Promise<GitInterdiffResult>;
  disposePiSession: (prKey: string) => Promise<void>;
  fetchCommitChecks: (ref: PullRequestRef, sha: string) => Promise<CommitChecks>;
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  getDraftReview: (prKey: string) => Promise<DraftReview | null>;
  listAiReviews: (prKey: string) => Promise<AiReviewRecord[]>;
  listFocusScans: (prKey: string) => Promise<FocusScanRecord[]>;
  listGuideReviews: (prKey: string) => Promise<GuideReviewRecord[]>;
  listOverviews: (prKey: string) => Promise<GuideReviewRecord[]>;
  parsePullRequestRef: (input: string) => PullRequestRef;
  preparePrWorktree: (ref: PullRequestRef, cloneUrl: string, headSha: string) => Promise<string>;
  prewarmPiSession: (prKey: string, purposes: string[]) => void;
  registerPiSessionContext: (prKey: string, cwd: string, context: { headSha: string; files: PullRequestReviewData["files"] }) => Promise<void>;
  removePullRequest: (prKey: string) => Promise<void>;
  upsertPullRequest: (pr: StoredPullRequest) => Promise<StoredPullRequest>;
};

export type PrApi = {
  parse: (input: string) => { ref: PullRequestRef };
  cleanup: (input: string) => Promise<{ ok: true; prKey: string; worktreeDir: string }>;
  activity: (input: string) => Promise<PullRequestReviewResponse>;
  open: (input: string) => Promise<PullRequestReviewResponse>;
  interdiff: (payload: Record<string, unknown>) => Promise<{ files: PullFile[]; totalCommits: number; sinceSha: string; headSha: string; source: "github" | "local-git"; rewritten: boolean }>;
  checks: (payload: Record<string, unknown>) => Promise<{ checks: CommitChecks }>;
};

function shaFromPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !/^[0-9a-f]{7,40}$/i.test(value)) throw new Error(`Expected ${key} to be a commit SHA`);
  return value;
}

function prUrlFromPayload(payload: Record<string, unknown>): string {
  if (typeof payload.prUrl !== "string" || payload.prUrl.length === 0) throw new Error("Expected prUrl");
  return payload.prUrl;
}

export const defaultPrApiDeps = (deps: Omit<PrApiDeps, "parsePullRequestRef">): PrApiDeps => ({ ...deps, parsePullRequestRef });

export function createPrApi(deps: PrApiDeps): PrApi {
  async function hydrateReviewResponse(data: PullRequestReviewData, pr: StoredPullRequest, extra: Partial<Pick<PullRequestReviewResponse, "worktreeDir">> = {}): Promise<PullRequestReviewResponse> {
    const [draftReview, focusScans, aiReviews, guideReviews, overviews] = await Promise.all([deps.getDraftReview(pr.key), deps.listFocusScans(pr.key), deps.listAiReviews(pr.key), deps.listGuideReviews(pr.key), deps.listOverviews(pr.key)]);
    return { ...data, pr, draftReview, focusScan: focusScans[0] ?? null, focusScans, aiReview: aiReviews[0] ?? null, aiReviews, guideReview: guideReviews.find((review) => review.headSha === pr.headSha) ?? null, overview: overviews.find((record) => record.headSha === pr.headSha) ?? null, ...extra };
  }

  function parse(input: string): { ref: PullRequestRef } {
    return { ref: deps.parsePullRequestRef(input) };
  }

  async function cleanup(input: string): Promise<{ ok: true; prKey: string; worktreeDir: string }> {
    const ref = deps.parsePullRequestRef(input);
    const key = prKey(ref);
    await deps.disposePiSession(key);
    const worktreeDir = await deps.cleanupPrWorktree(ref);
    await deps.removePullRequest(key);
    return { ok: true, prKey: key, worktreeDir };
  }

  async function activity(input: string): Promise<PullRequestReviewResponse> {
    const ref = deps.parsePullRequestRef(input);
    const data = await deps.fetchPullRequestReviewData(ref);
    const pr = await deps.upsertPullRequest(data.pr);
    const worktreeDir = await deps.preparePrWorktree(ref, data.raw.base.repo.clone_url, data.pr.headSha);
    await deps.registerPiSessionContext(pr.key, worktreeDir, { headSha: pr.headSha, files: data.files });
    return hydrateReviewResponse(data, pr, { worktreeDir });
  }

  async function open(input: string): Promise<PullRequestReviewResponse> {
    const ref = deps.parsePullRequestRef(input);
    const data = await deps.fetchPullRequestReviewData(ref);
    const pr = await deps.upsertPullRequest(data.pr);
    const worktreeDir = await deps.preparePrWorktree(ref, data.raw.base.repo.clone_url, data.pr.headSha);
    await deps.registerPiSessionContext(pr.key, worktreeDir, { headSha: pr.headSha, files: data.files });
    deps.prewarmPiSession(pr.key, ["main-review", "focus-review"]);
    return hydrateReviewResponse(data, pr, { worktreeDir });
  }

  /** The current PR file list (with GitHub patches) the client already holds, for the rewritten-history signature compare. */
  function currentFilesFromPayload(payload: Record<string, unknown>): PullFile[] {
    if (!Array.isArray(payload.files)) return [];
    return payload.files.slice(0, 400).flatMap((entry) => {
      if (typeof entry !== "object" || entry == null) return [];
      const file = entry as Record<string, unknown>;
      if (!safeDiffPath(file.filename)) return [];
      return [{
        filename: file.filename,
        status: typeof file.status === "string" ? file.status : "modified",
        additions: typeof file.additions === "number" ? file.additions : 0,
        deletions: typeof file.deletions === "number" ? file.deletions : 0,
        changes: typeof file.changes === "number" ? file.changes : 0,
        ...(typeof file.patch === "string" ? { patch: file.patch } : {}),
        ...(typeof file.previous_filename === "string" ? { previous_filename: file.previous_filename } : {}),
        ...(file.generated === true ? { generated: true } : {}),
      }];
    });
  }

  /**
   * Diff of what changed since the reviewer's last look. Local git first: it
   * distinguishes appended commits (exact delta) from rewritten history
   * (ghstack/rebase), where GitHub's compare would report every upstream
   * commit the rebase pulled in. The compare API is only a fallback for when
   * the old head is unavailable locally.
   */
  async function interdiff(payload: Record<string, unknown>): Promise<{ files: PullFile[]; totalCommits: number; sinceSha: string; headSha: string; source: "github" | "local-git"; rewritten: boolean }> {
    const ref = deps.parsePullRequestRef(prUrlFromPayload(payload));
    const sinceSha = shaFromPayload(payload, "sinceSha");
    const headSha = shaFromPayload(payload, "headSha");
    const currentFiles = currentFilesFromPayload(payload);
    try {
      const { files, totalCommits, rewritten } = await deps.compareCommitsLocally(ref, sinceSha, headSha, currentFiles);
      return { files, totalCommits, sinceSha, headSha, source: "local-git", rewritten };
    } catch (localError) {
      const { files, totalCommits } = await deps.compareCommits(ref, sinceSha, headSha).catch(() => {
        throw localError;
      });
      // A compare spanning far more files than the PR itself means the history
      // was rewritten and this is rebase noise, not the reviewer's delta.
      if (currentFiles.length > 0 && files.length > currentFiles.length * 2) throw localError;
      return { files, totalCommits, sinceSha, headSha, source: "github", rewritten: false };
    }
  }

  async function checks(payload: Record<string, unknown>): Promise<{ checks: CommitChecks }> {
    const ref = deps.parsePullRequestRef(prUrlFromPayload(payload));
    return { checks: await deps.fetchCommitChecks(ref, shaFromPayload(payload, "sha")) };
  }

  return { parse, cleanup, activity, open, interdiff, checks };
}
