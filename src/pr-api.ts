import { prKeyForRef } from "./http.js";
import { parsePullRequestRef } from "./pr.js";
import type { AiReviewRecord, FocusScanRecord, PullRequestRef, PullRequestReviewData, PullRequestReviewResponse, StoredPullRequest } from "./types.js";

export type PrApiDeps = {
  cleanupPrWorktree: (ref: PullRequestRef) => Promise<string>;
  disposePiSession: (prKey: string) => Promise<void>;
  fetchPullRequestReviewData: (ref: PullRequestRef) => Promise<PullRequestReviewData>;
  listAiReviews: (prKey: string) => Promise<AiReviewRecord[]>;
  listFocusScans: (prKey: string) => Promise<FocusScanRecord[]>;
  parsePullRequestRef: (input: string) => PullRequestRef;
  preparePrWorktree: (ref: PullRequestRef, cloneUrl: string, headSha: string) => Promise<string>;
  prewarmPiSession: (prKey: string, purposes: string[]) => void;
  registerPiSessionCwd: (prKey: string, cwd: string) => Promise<void>;
  removePullRequest: (prKey: string) => Promise<void>;
  upsertPullRequest: (pr: StoredPullRequest) => Promise<StoredPullRequest>;
};

export type PrApi = {
  parse: (input: string) => { ref: PullRequestRef };
  cleanup: (input: string) => Promise<{ ok: true; prKey: string; worktreeDir: string }>;
  activity: (input: string) => Promise<PullRequestReviewResponse>;
  open: (input: string) => Promise<PullRequestReviewResponse>;
  hydrateReviewResponse: (data: PullRequestReviewData, pr: StoredPullRequest, extra?: Partial<Pick<PullRequestReviewResponse, "worktreeDir">>) => Promise<PullRequestReviewResponse>;
};

export const defaultPrApiDeps = (deps: Omit<PrApiDeps, "parsePullRequestRef">): PrApiDeps => ({ ...deps, parsePullRequestRef });

export function createPrApi(deps: PrApiDeps): PrApi {
  async function hydrateReviewResponse(data: PullRequestReviewData, pr: StoredPullRequest, extra: Partial<Pick<PullRequestReviewResponse, "worktreeDir">> = {}): Promise<PullRequestReviewResponse> {
    const [focusScans, aiReviews] = await Promise.all([deps.listFocusScans(pr.key), deps.listAiReviews(pr.key)]);
    return { ...data, pr, focusScan: focusScans[0] ?? null, focusScans, aiReview: aiReviews[0] ?? null, aiReviews, ...extra };
  }

  function parse(input: string): { ref: PullRequestRef } {
    return { ref: deps.parsePullRequestRef(input) };
  }

  async function cleanup(input: string): Promise<{ ok: true; prKey: string; worktreeDir: string }> {
    const ref = deps.parsePullRequestRef(input);
    const prKey = prKeyForRef(ref);
    await deps.disposePiSession(prKey);
    const worktreeDir = await deps.cleanupPrWorktree(ref);
    await deps.removePullRequest(prKey);
    return { ok: true, prKey, worktreeDir };
  }

  async function activity(input: string): Promise<PullRequestReviewResponse> {
    const ref = deps.parsePullRequestRef(input);
    const data = await deps.fetchPullRequestReviewData(ref);
    return hydrateReviewResponse(data, await deps.upsertPullRequest(data.pr));
  }

  async function open(input: string): Promise<PullRequestReviewResponse> {
    const ref = deps.parsePullRequestRef(input);
    const data = await deps.fetchPullRequestReviewData(ref);
    const pr = await deps.upsertPullRequest(data.pr);
    const worktreeDir = await deps.preparePrWorktree(ref, data.raw.base.repo.clone_url, data.pr.headSha);
    await deps.registerPiSessionCwd(pr.key, worktreeDir);
    deps.prewarmPiSession(pr.key, ["main-review", "focus-review", "chat", "inline-chat", "focus-chat"]);
    return hydrateReviewResponse(data, pr, { worktreeDir });
  }

  return { parse, cleanup, activity, open, hydrateReviewResponse };
}
