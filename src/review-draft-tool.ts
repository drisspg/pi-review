import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { appendDraftReviewComment } from "./state.js";
import type { DraftReview, PullFile } from "./types.js";

export type ReviewDraftToolContext = {
  headSha: string;
  files: PullFile[];
};

export type ReviewDraftToolDeps = {
  appendDraftReviewComment: (prKey: string, headSha: string, comment: Omit<DraftReview["comments"][number], "id">) => Promise<{ draftReview: DraftReview; comment: DraftReview["comments"][number]; created: boolean }>;
};

type ReviewDraftToolParams = {
  path: string;
  line: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  body: string;
};

const defaultDeps: ReviewDraftToolDeps = { appendDraftReviewComment };

/** Return the patch hunk containing an absolute line on the selected diff side. */
function hunkForLine(patch: string, side: "RIGHT" | "LEFT", targetLine: number): number | null {
  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  for (const row of patch.split("\n")) {
    const header = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header != null) {
      oldLine = Number.parseInt(header[1], 10);
      newLine = Number.parseInt(header[2], 10);
      hunk += 1;
      continue;
    }
    if (hunk < 0 || row.startsWith("\\ No newline")) continue;
    if (row.startsWith("+")) {
      if (side === "RIGHT" && newLine === targetLine) return hunk;
      newLine += 1;
      continue;
    }
    if (row.startsWith("-")) {
      if (side === "LEFT" && oldLine === targetLine) return hunk;
      oldLine += 1;
      continue;
    }
    if (side === "RIGHT" ? newLine === targetLine : oldLine === targetLine) return hunk;
    oldLine += 1;
    newLine += 1;
  }
  return null;
}

/** Normalize a requested draft and reject locations GitHub cannot anchor in this diff. */
function validateTarget(context: ReviewDraftToolContext, params: ReviewDraftToolParams): Omit<DraftReview["comments"][number], "id"> {
  const path = params.path.trim();
  const body = params.body.trim();
  const side = params.side ?? "RIGHT";
  const file = context.files.find((candidate) => candidate.filename === path);
  if (file == null) throw new Error(`${path} is not a changed file in the current PR.`);
  if (file.patch == null || file.patch.length === 0) throw new Error(`The patch for ${path} is unavailable, so an inline draft cannot be placed safely.`);
  if (!Number.isInteger(params.line) || params.line < 1) throw new Error("line must be a positive integer.");
  if (params.startLine != null && (!Number.isInteger(params.startLine) || params.startLine < 1 || params.startLine > params.line)) throw new Error("startLine must be a positive integer no greater than line.");
  if (body.length === 0) throw new Error("body must not be empty.");
  const endHunk = hunkForLine(file.patch, side, params.line);
  if (endHunk == null) throw new Error(`${path}:${params.line} is not reviewable on the ${side} side of the current diff.`);
  if (params.startLine != null && hunkForLine(file.patch, side, params.startLine) !== endHunk) throw new Error("startLine and line must be reviewable within the same diff hunk.");
  return { path, line: params.line, startLine: params.startLine, side, body };
}

/** Create the conversation-only tool that persists editable local review drafts. */
export function createReviewDraftTool(prKey: string, context: ReviewDraftToolContext, deps: ReviewDraftToolDeps = defaultDeps) {
  return defineTool({
    name: "draft_review_comment",
    label: "Draft Review Comment",
    description: "Create a private local Pi Review draft comment when the user explicitly asks to draft, add, or turn feedback into a review comment. The draft is editable in the UI and is not published to GitHub.",
    parameters: Type.Object({
      path: Type.String({ description: "Exact changed-file path from the repository root." }),
      line: Type.Integer({ minimum: 1, description: "Absolute ending line number on the selected diff side." }),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute starting line for a multiline comment. Omit for a single-line comment." })),
      side: Type.Optional(Type.Union([Type.Literal("RIGHT"), Type.Literal("LEFT")], { description: "RIGHT for new/context lines or LEFT for removed/context lines. Defaults to RIGHT." })),
      body: Type.String({ minLength: 1, description: "Concise review comment text written in the user's voice." }),
    }),
    async execute(_toolCallId, rawParams) {
      const result = await deps.appendDraftReviewComment(prKey, context.headSha, validateTarget(context, rawParams as ReviewDraftToolParams));
      const range = result.comment.startLine != null && result.comment.startLine !== result.comment.line ? `${result.comment.startLine}-${result.comment.line}` : String(result.comment.line);
      const message = result.created ? "Created private editable draft" : "Private editable draft already exists";
      return {
        content: [{ type: "text", text: `${message} at ${result.comment.path}:${range}. It remains local until the user submits the review.` }],
        details: result,
      };
    },
  });
}
