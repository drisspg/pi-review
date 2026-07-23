import type { DraftComment, FocusArea, PullReviewComment, Target, Thread } from "../types";

export type DiffAnnotationIndex = {
  commentThreadsByFile: Map<string, PullReviewComment[][]>;
  commentThreadsByTarget: Map<string, PullReviewComment[][]>;
  draftsByTarget: Map<string, DraftComment[]>;
  focusAreasByTarget: Map<string, FocusArea[]>;
  threadsByTarget: Map<string, Thread>;
  openThreadRangeTargets: Set<string>;
};

export function targetKey(target: Target): string {
  return `${target.path}:${target.side}:${target.startLine ?? target.line ?? "file"}:${target.line ?? "file"}`;
}

export function commentThreadDomId(target: Target): string {
  return `github-thread-${targetKey(target)}`;
}

export function diffAnnotationTargetKey(target: Pick<Target, "path" | "side" | "line">): string {
  return `${target.path}:${target.side}:${target.line ?? "file"}`;
}

export function commentTarget(comment: PullReviewComment): Target {
  return { path: comment.path, startLine: comment.start_line ?? comment.line ?? comment.original_line ?? null, line: comment.line ?? comment.original_line ?? null, side: comment.side ?? comment.original_side ?? "RIGHT", hunk: "" };
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

export function buildDiffAnnotationIndex(comments: PullReviewComment[], drafts: DraftComment[], threads: Record<string, Thread>, focusAreas: FocusArea[]): DiffAnnotationIndex {
  const commentThreadsByFile = new Map<string, PullReviewComment[][]>();
  const commentThreadsByTarget = new Map<string, PullReviewComment[][]>();
  for (const commentThread of groupReviewComments(comments)) {
    const target = commentTarget(commentThread[0]);
    const key = diffAnnotationTargetKey(target);
    commentThreadsByFile.set(target.path, [...(commentThreadsByFile.get(target.path) ?? []), commentThread]);
    commentThreadsByTarget.set(key, [...(commentThreadsByTarget.get(key) ?? []), commentThread]);
  }

  const draftsByTarget = new Map<string, DraftComment[]>();
  for (const draft of drafts) {
    const key = diffAnnotationTargetKey(draft);
    draftsByTarget.set(key, [...(draftsByTarget.get(key) ?? []), draft]);
  }

  const focusAreasByTarget = new Map<string, FocusArea[]>();
  for (const area of focusAreas) {
    const key = diffAnnotationTargetKey({ path: area.path, side: "RIGHT", line: area.startLine });
    focusAreasByTarget.set(key, [...(focusAreasByTarget.get(key) ?? []), area]);
  }

  const threadsByTarget = new Map<string, Thread>();
  const openThreadRangeTargets = new Set<string>();
  for (const thread of Object.values(threads)) {
    const key = diffAnnotationTargetKey(thread.target);
    if (!threadsByTarget.has(key)) threadsByTarget.set(key, thread);
    if (thread.collapsed || thread.target.startLine == null || thread.target.line == null) continue;
    for (let line = thread.target.startLine; line <= thread.target.line; line += 1) openThreadRangeTargets.add(diffAnnotationTargetKey({ ...thread.target, line }));
  }

  return { commentThreadsByFile, commentThreadsByTarget, draftsByTarget, focusAreasByTarget, threadsByTarget, openThreadRangeTargets };
}

export function targetLabel(target: Pick<Target, "path" | "line" | "startLine">): string {
  return `${target.path}:${target.line == null ? "file" : target.startLine != null && target.startLine !== target.line ? `${target.startLine}-${target.line}` : target.line}`;
}
