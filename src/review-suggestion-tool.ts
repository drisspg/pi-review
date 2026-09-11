/** Format GitHub-applicable inline suggestions and reuse the existing private comment pipeline. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ReviewSuggestionTarget = { path: string; line: number; startLine?: number; side?: "RIGHT" | "LEFT" };

/** Keep replacement code literal, including indentation and embedded Markdown fences. */
export function suggestionBody(code: string): string {
  let fence = "```";
  for (const [ticks] of code.matchAll(/`+/g)) {
    if (ticks.length >= fence.length) fence = "`".repeat(ticks.length + 1);
  }
  return `${fence}suggestion\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** Turn replacement code into a private inline comment, never a review verdict or file edit. */
export function createReviewSuggestionTool(commentTool: Pick<ToolDefinition, "execute">, target?: ReviewSuggestionTarget) {
  return defineTool({
    name: "suggest_change",
    label: "Suggest Change",
    description: "Draft an inline GitHub suggested change that the PR author can Apply suggestion after the review is published. Supply only the exact replacement code, without Markdown fences or explanatory prose. Replaces the selected new-file line or range; an empty code string suggests deleting it. This creates a private editable comment and does not modify files or publish anything.",
    promptSnippet: "Draft exact replacement code as a GitHub Apply suggestion comment",
    promptGuidelines: ["Use suggest_change when the user wants exact code that the PR author can accept or apply. Pass code only, preserving indentation. Omit path and line to use the current inline selection; explicit line numbers always refer to the new (RIGHT) side."],
    parameters: Type.Object({
      code: Type.String({ description: "Exact replacement code, without prose or fences. Empty string deletes the selected lines." }),
      path: Type.Optional(Type.String({ description: "Changed-file path; omit to use the current inline selection." })),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "Last new-file line being replaced; omit to use the current inline selection." })),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First new-file line being replaced, for a multiline suggestion." })),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const useAnchor = params.line === undefined && (params.path === undefined || params.path === target?.path);
      if (useAnchor && target?.side === "LEFT") throw new Error("GitHub suggestions must target the new (RIGHT) side, not deleted lines. Select a new-file line or provide explicit new-file coordinates.");
      const path = params.path ?? target?.path;
      const line = params.line ?? (useAnchor ? target?.line : undefined);
      const startLine = params.startLine ?? (useAnchor ? target?.startLine : undefined);
      if (!path || line === undefined) throw new Error("Specify the changed-file path and new-file line for this suggestion.");
      if (!Number.isInteger(line) || line < 1 || (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1 || startLine > line))) throw new Error("Suggestion lines must be positive integers with startLine no greater than line.");
      return commentTool.execute(id, { path, line, ...(startLine === undefined ? {} : { startLine }), side: "RIGHT", body: suggestionBody(params.code) }, signal, onUpdate, ctx);
    },
  });
}
