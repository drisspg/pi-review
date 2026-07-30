import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ReviewTarget = {
  path: string;
  line: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
};

type DraftCommentParams = {
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  body: string;
};

function defaultTarget(): ReviewTarget | null {
  const raw = process.env.PI_REVIEW_TARGET;
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as ReviewTarget;
  } catch {
    return null;
  }
}

/** Add Pi Review comment semantics and tools to embedded terminal sessions. */
export default function piReviewTerminalExtension(pi: ExtensionAPI) {
  const target = defaultTarget();
  pi.registerTool({
    name: "draft_review_comment",
    label: "Draft Review Comment",
    description: target == null
      ? "Create a private editable Pi Review comment on a changed line. Use this instead of editing source when the user asks to add, leave, post, or write a PR review comment."
      : `Create a private editable Pi Review comment anchored at ${target.path}:${target.startLine == null || target.startLine === target.line ? target.line : `${target.startLine}-${target.line}`}. Use this instead of editing source when the user asks to comment on this thread.`,
    promptSnippet: "Create editable PR review comments without modifying source files",
    promptGuidelines: [
      "Use draft_review_comment when the user asks to add, leave, post, or write a PR review comment instead of editing repository files; only edit code when the user explicitly asks for a code change.",
      "For an inline Pi Review thread, draft_review_comment already targets the anchored line or range, so normally provide only the comment body.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Changed-file path. Omit in an inline thread to use its anchored file." })),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "Ending diff line. Omit in an inline thread to use its anchored line." })),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "Starting line for a multiline comment." })),
      side: Type.Optional(StringEnum(["RIGHT", "LEFT"] as const)),
      body: Type.String({ minLength: 1, description: "Concise review comment text in the user's voice." }),
    }),
    async execute(_toolCallId, params: DraftCommentParams, signal) {
      const apiUrl = process.env.PI_REVIEW_API_URL;
      const prKey = process.env.PI_REVIEW_PR_KEY;
      const headSha = process.env.PI_REVIEW_HEAD_SHA;
      const path = params.path ?? target?.path;
      const line = params.line ?? target?.line;
      if (apiUrl == null || prKey == null || headSha == null) throw new Error("Pi Review did not provide the terminal review context.");
      if (path == null || line == null) throw new Error("Specify the changed-file path and diff line for this review comment.");
      const response = await fetch(`${apiUrl}/api/pi/draft-comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prKey,
          headSha,
          path,
          line,
          startLine: params.startLine ?? target?.startLine,
          side: params.side ?? target?.side ?? "RIGHT",
          body: params.body,
        }),
        signal,
      });
      const result = await response.json() as { comment?: { path: string; line: number; startLine?: number }; created?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? `Pi Review rejected the comment (${response.status}).`);
      const comment = result.comment;
      const range = comment?.startLine != null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : String(comment?.line ?? line);
      return {
        content: [{ type: "text", text: `${result.created === false ? "Review draft already exists" : "Created editable review draft"} at ${comment?.path ?? path}:${range}. It remains private until the review is submitted.` }],
        details: result,
      };
    },
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nPi Review comment semantics: requests to add, leave, post, write, or put a comment on the PR or current line mean creating an editable review draft with draft_review_comment. Do not modify repository files for those requests. Only edit code when the user explicitly asks for a source-code change.`,
  }));
}
