import { validateReviewDraftTarget, type ReviewDraftToolContext, type ReviewDraftToolParams } from "./review-draft-tool.js";
import type { DraftReview } from "./types.js";

export type PiTerminalDraftApiDeps = {
  appendDraftReviewComment: (prKey: string, headSha: string, comment: Omit<DraftReview["comments"][number], "id">) => Promise<{ draftReview: DraftReview; comment: DraftReview["comments"][number]; created: boolean }>;
  contextForPr: (prKey: string) => ReviewDraftToolContext | null;
  notifyDraftReview: (prKey: string, draftReview: DraftReview) => Promise<void>;
};

function draftRequest(payload: Record<string, unknown>): { prKey: string; headSha: string; params: ReviewDraftToolParams } {
  const { prKey, headSha, path, line, startLine, side, body } = payload;
  if (typeof prKey !== "string" || typeof headSha !== "string" || typeof path !== "string" || typeof line !== "number" || typeof body !== "string") {
    throw new Error("Expected prKey, headSha, path, line, and body");
  }
  if (startLine != null && typeof startLine !== "number") throw new Error("startLine must be a number");
  if (side != null && side !== "RIGHT" && side !== "LEFT") throw new Error("side must be RIGHT or LEFT");
  return { prKey, headSha, params: { path, line, body, ...(startLine == null ? {} : { startLine }), ...(side == null ? {} : { side }) } };
}

/** Persist review comments requested from native Pi terminal sessions. */
export function createPiTerminalDraftApi(deps: PiTerminalDraftApiDeps) {
  async function add(payload: Record<string, unknown>) {
    const request = draftRequest(payload);
    const context = deps.contextForPr(request.prKey);
    if (context == null) throw new Error("Refresh this pull request before creating review comments from Pi.");
    if (context.headSha !== request.headSha) throw new Error("The pull request changed. Refresh it before creating this review comment.");
    const result = await deps.appendDraftReviewComment(request.prKey, request.headSha, validateReviewDraftTarget(context, request.params));
    await deps.notifyDraftReview(request.prKey, result.draftReview);
    return result;
  }

  return { add };
}

export type PiTerminalDraftApi = ReturnType<typeof createPiTerminalDraftApi>;
