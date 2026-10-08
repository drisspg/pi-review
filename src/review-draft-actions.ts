import { StringEnum, Type } from "@earendil-works/pi-ai";

import type { DraftReviewComment } from "./types.js";

/**
 * Non-create actions of the single `draft_review_comment` tool: list, edit (replace body in place),
 * and delete private Pi Review drafts. Shared by terminal sessions (HTTP to the server) and
 * in-process background sessions (state directly); neither touches GitHub. Free of state imports
 * so the terminal extension can load it inside the Pi process.
 */
export type ReviewDraftOps = {
  list: (signal?: AbortSignal) => Promise<DraftReviewComment[]>;
  edit: (id: string, body: string, signal?: AbortSignal) => Promise<DraftReviewComment>;
  remove: (id: string, signal?: AbortSignal) => Promise<DraftReviewComment>;
};

export type DraftAction = "create" | "edit" | "delete" | "list";

/** Schema fields every host adds to draft_review_comment; `body` becomes optional (required for create/edit at run time). */
export const draftActionParameters = {
  action: Type.Optional(StringEnum(["create", "edit", "delete", "list"] as const, { description: "create (default) a new draft; edit replaces an existing draft's body in place; delete removes a draft; list shows drafts with ids." })),
  id: Type.Optional(Type.String({ minLength: 1, description: "Draft id for edit/delete (from list or a create result)." })),
};

export const draftActionGuidelines = [
  "To revise or reword an existing review comment, call draft_review_comment with action \"edit\" and its id (action \"list\" shows ids) instead of creating a replacement; use action \"delete\" for superseded or duplicate drafts.",
  "Only edit or delete a reviewer-authored draft (id not starting with pi-) when the user explicitly asks.",
];

/** Model-created drafts get `pi-` ids; everything else was written by the reviewer. */
export function draftAuthor(comment: Pick<DraftReviewComment, "id">): "Pi" | "reviewer" {
  return comment.id.startsWith("pi-") ? "Pi" : "reviewer";
}

export function draftLocation(comment: Pick<DraftReviewComment, "path" | "line" | "startLine" | "side">): string {
  const range = comment.startLine != null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : String(comment.line);
  return `${comment.path}:${range}${comment.side === "LEFT" ? " (LEFT)" : ""}`;
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

/** Run a non-create action; returns null for create so the host's own create path handles it. */
export async function runDraftAction(ops: ReviewDraftOps, params: { action?: DraftAction; id?: string; body?: string }, signal?: AbortSignal): Promise<ToolResult | null> {
  const action = params.action ?? "create";
  if (action === "create") return null;
  if (action === "list") {
    const comments = await ops.list(signal);
    const text = comments.length === 0 ? "No private review drafts on this PR." : comments.map((comment) => `- ${comment.id} · ${draftLocation(comment)} · by ${draftAuthor(comment)}: ${preview(comment.body)}`).join("\n");
    return { content: [{ type: "text", text }], details: { comments } };
  }
  if (params.id == null || params.id.trim().length === 0) throw new Error(`action "${action}" needs the draft id (use action "list" to find it).`);
  if (action === "edit") {
    if (params.body == null || params.body.trim().length === 0) throw new Error("action \"edit\" needs the complete new body.");
    const comment = await ops.edit(params.id, params.body, signal);
    return { content: [{ type: "text", text: `Updated private review draft ${comment.id} at ${draftLocation(comment)} in place. Still unpublished.` }], details: { comment } };
  }
  const comment = await ops.remove(params.id, signal);
  return { content: [{ type: "text", text: `Deleted private review draft ${comment.id} at ${draftLocation(comment)}.` }], details: { comment } };
}
