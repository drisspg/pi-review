import type { PullFile, PullRequestReviewData, ReviewMemoryChangeSet, ReviewMemoryComment } from "./types.js";

export type ReviewSubmitComment = {
  draft_id?: unknown;
  path?: unknown;
  line?: unknown;
  start_line?: unknown;
  side?: unknown;
  start_side?: unknown;
  body?: unknown;
};

export function reviewSubmitCommentsFromPayload(comments: unknown): ReviewSubmitComment[] {
  return Array.isArray(comments) ? comments.filter((comment): comment is ReviewSubmitComment => typeof comment === "object" && comment != null) : [];
}

export function githubReviewComments(comments: ReviewSubmitComment[]): Array<Record<string, unknown>> {
  return comments.map(({ path, line, start_line, side, start_side, body }) => ({
    path,
    line,
    side,
    body,
    ...(typeof start_line === "number" && start_line !== line ? { start_line, start_side } : {}),
  }));
}

export function reviewMemoryComments(comments: ReviewSubmitComment[]): ReviewMemoryComment[] {
  return comments.flatMap(reviewMemoryCommentFromPayload).filter((comment) => comment.body.length > 0);
}

export function reviewMemoryFiles(files: PullFile[], comments: ReviewMemoryComment[]): ReviewMemoryChangeSet["files"] {
  const commentedPaths = new Set(comments.map((comment) => comment.path));
  return files.filter((file) => commentedPaths.size === 0 || commentedPaths.has(file.filename)).map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  }));
}

export function reviewMemoryChangeSet(data: Pick<PullRequestReviewData, "raw" | "files">, comments: ReviewMemoryComment[]): ReviewMemoryChangeSet {
  return {
    title: data.raw.title,
    url: data.raw.html_url,
    source: `${data.raw.base.repo.full_name}#${data.raw.number}`,
    files: reviewMemoryFiles(data.files, comments),
  };
}

export function reviewMemoryCommentFromPayload(comment: ReviewSubmitComment): ReviewMemoryComment[] {
  if (typeof comment.path !== "string" || typeof comment.body !== "string") return [];
  const side: ReviewMemoryComment["side"] | null = comment.side === "RIGHT" || comment.side === "LEFT" ? comment.side : null;
  if (side == null) return [];
  return [{
    path: comment.path,
    line: typeof comment.line === "number" ? comment.line : null,
    startLine: typeof comment.start_line === "number" ? comment.start_line : null,
    side,
    body: comment.body.trim(),
  }];
}

export function reviewSubmitDiagnostics(comments: ReviewSubmitComment[]): string {
  if (comments.length === 0) return "No inline comments were included in the failed review payload.";
  const rows = comments.map((comment, index) => {
    const draftId = typeof comment.draft_id === "string" ? ` draft=${comment.draft_id}` : "";
    const path = typeof comment.path === "string" ? comment.path : "<missing path>";
    const line = typeof comment.line === "number" ? comment.line : "<missing line>";
    const startLine = typeof comment.start_line === "number" && comment.start_line !== comment.line ? `${comment.start_line}-` : "";
    const side = typeof comment.side === "string" ? comment.side : "<missing side>";
    const body = typeof comment.body === "string" ? comment.body.replace(/\s+/g, " ").trim().slice(0, 120) : "<missing body>";
    return `${index + 1}.${draftId} ${path}:${startLine}${line} ${side} — ${body}`;
  });
  return `Inline comments in the failed review payload:\n${rows.join("\n")}`;
}

export function reviewSubmitFailureMessage(error: unknown, comments: ReviewSubmitComment[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n\n${reviewSubmitDiagnostics(comments)}\n\nIf GitHub returned HTTP 422, delete or recreate the listed draft whose path/line is stale, then retry.`;
}
