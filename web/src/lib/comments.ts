import type { DraftComment, PullReviewComment, Target } from "../types";

export function targetKey(target: Target): string {
  return `${target.path}:${target.side}:${target.startLine ?? target.line ?? "file"}:${target.line ?? "file"}`;
}

export function commentThreadDomId(target: Target): string {
  return `github-thread-${targetKey(target)}`;
}

export function commentTarget(comment: PullReviewComment): Target {
  return { path: comment.path, startLine: comment.start_line ?? comment.line ?? comment.original_line ?? null, line: comment.line ?? comment.original_line ?? null, side: comment.side ?? comment.original_side ?? "RIGHT", hunk: "" };
}

export function draftMatchesTarget(draft: DraftComment, target: Target): boolean {
  return draft.path === target.path && draft.side === target.side && draft.line === target.line;
}

export function threadForTarget<T extends { target: Target }>(threads: Record<string, T>, target: Target): T | null {
  return threads[targetKey(target)] ?? Object.values(threads).find((thread) => thread.target.path === target.path && thread.target.side === target.side && thread.target.line === target.line) ?? null;
}

export function groupReviewComments(comments: PullReviewComment[]): PullReviewComment[][] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const rootForComment = (comment: PullReviewComment): PullReviewComment => {
    let root = comment;
    while (root.in_reply_to_id != null && byId.has(root.in_reply_to_id)) root = byId.get(root.in_reply_to_id)!;
    return root;
  };
  const groups = new Map<string, PullReviewComment[]>();
  for (const comment of comments) {
    const root = rootForComment(comment);
    const key = targetKey(commentTarget(root));
    groups.set(key, [...(groups.get(key) ?? []), comment]);
  }
  return [...groups.values()].map((thread) => thread.sort((a, b) => a.id - b.id));
}

export function targetLabel(target: Pick<Target, "path" | "line" | "startLine">): string {
  return `${target.path}:${target.line == null ? "file" : target.startLine != null && target.startLine !== target.line ? `${target.startLine}-${target.line}` : target.line}`;
}
