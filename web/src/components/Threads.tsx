import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, LinkExternalIcon } from "@primer/octicons-react";

import { api } from "../api";
import { Button } from "./Button";
import { commentTarget, commentThreadDomId, groupReviewComments, targetLabel } from "../lib/comments";
import type { PullIssueComment, PullRequestReviewSummary, PullReviewComment } from "../types";
import { MarkdownText } from "./Markdown";

const commenterPalette = ["blue", "purple", "green", "orange", "pink", "teal"] as const;

function commenterTone(login: string): string {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return commenterPalette[hash % commenterPalette.length];
}

function avatarLabel(login: string): string {
  return login.slice(0, 1).toUpperCase();
}

function commentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

function resolvedLabel(comments: PullReviewComment[]): string | null {
  const resolved = comments.find((comment) => comment.thread_resolved != null)?.thread_resolved;
  return resolved == null ? null : resolved ? "Resolved" : "Unresolved";
}

function reviewerHandle(input: string): string {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

function commentIncludesReviewer(comment: PullReviewComment | PullIssueComment | PullRequestReviewSummary, reviewer: string): boolean {
  if (reviewer.length === 0) return true;
  const login = comment.user?.login?.toLowerCase();
  return login === reviewer || new RegExp(`(^|\\W)@${reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\W|$)`, "i").test(comment.body);
}

function threadIncludesReviewer(comments: Array<PullReviewComment | PullIssueComment | PullRequestReviewSummary>, reviewer: string): boolean {
  return comments.some((comment) => commentIncludesReviewer(comment, reviewer));
}

function reviewerOptions(comments: Array<PullReviewComment | PullIssueComment | PullRequestReviewSummary>): string[] {
  const reviewers = new Set<string>();
  for (const comment of comments) {
    if (comment.user?.login != null) reviewers.add(comment.user.login);
    for (const match of comment.body.matchAll(/@([A-Za-z0-9-]+)/g)) reviewers.add(match[1]);
  }
  return [...reviewers].sort((a, b) => a.localeCompare(b));
}

export function ExistingReviewThread({ comments, prUrl, refreshGithubActivity, collapseSignal = 0, collapseComments = true }: { comments: PullReviewComment[]; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal?: number; collapseComments?: boolean }) {
  const target = commentTarget(comments[0]);
  const status = resolvedLabel(comments);
  const locationState = comments[0].line == null && comments[0].original_line != null ? " · Outdated" : "";
  return <GitHubThreadCard id={commentThreadDomId(target)} className="inline-thread existing" title="GitHub thread" subtitle={`${targetLabel(target)} · ${commentCountLabel(comments.length)}${locationState}`} status={status} href={comments[0].html_url} comments={comments} commentKind="review" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={collapseComments} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={comments[0].id} refreshGithubActivity={refreshGithubActivity} />} />;
}

function ReviewCommentTimeline({ comments, commentKind, prUrl, refreshGithubActivity }: { comments: Array<PullReviewComment | PullIssueComment | PullRequestReviewSummary>; commentKind: "issue" | "review" | "review-summary"; prUrl: string; refreshGithubActivity: () => Promise<void> }) {
  return <div className="github-comment-timeline">{comments.map((comment) => <GitHubCommentView key={comment.id} comment={comment} commentKind={commentKind} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} />)}</div>;
}

function GitHubCommentView({ comment, commentKind, prUrl, refreshGithubActivity }: { comment: PullReviewComment | PullIssueComment | PullRequestReviewSummary; commentKind: "issue" | "review" | "review-summary"; prUrl: string; refreshGithubActivity: () => Promise<void> }) {
  const login = comment.user?.login ?? "github";
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [submitting, setSubmitting] = useState(false);
  async function saveEdit() {
    if (body.trim().length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api("/api/comment/edit", { method: "POST", body: JSON.stringify({ prUrl, kind: commentKind, commentId: comment.id, body }) });
      setEditing(false);
      void refreshGithubActivity();
    } finally {
      setSubmitting(false);
    }
  }
  return <div className={`github-comment commenter-${commenterTone(login)}`}><div className="avatar" aria-hidden="true">{avatarLabel(login)}</div><div className="github-comment-body"><div className="github-comment-header"><strong>@{login}</strong><Button variant="muted" className="small-muted-button" onClick={() => { setBody(comment.body); setEditing(!editing); }}>{editing ? "Cancel" : "Edit"}</Button></div>{editing ? <div className="thread-reply github-comment-edit"><textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label="Edit comment" /><Button variant="muted" onClick={() => void saveEdit()} disabled={submitting || body.trim().length === 0}>{submitting ? "Saving…" : "Save"}</Button></div> : <MarkdownText text={body} />}</div></div>;
}

function GitHubThreadCard({ id, className = "comment", title, subtitle, status, href, comments, commentKind, prUrl, refreshGithubActivity, reply, collapseSignal = 0, collapseComments = true, onJump }: { id?: string; className?: string; title: string; subtitle: string; status?: string | null; href: string; comments: Array<PullReviewComment | PullIssueComment | PullRequestReviewSummary>; commentKind: "issue" | "review" | "review-summary"; prUrl: string; refreshGithubActivity: () => Promise<void>; reply?: React.ReactNode; collapseSignal?: number; collapseComments?: boolean; onJump?: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (collapseSignal > 0) setCollapsed(collapseComments);
  }, [collapseSignal, collapseComments]);
  const body = <><ReviewCommentTimeline comments={comments} commentKind={commentKind} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} />{reply}</>;
  const jumpProps = onJump == null ? {} : { onClick: onJump, role: "button", tabIndex: 0, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onJump(); } } };
  return <div id={id} className={`${className} github-thread ${collapsed ? "minimized" : ""}`}>
    <div className={`thread-head${onJump != null ? " jumpable" : ""}`}>
      <div className="thread-title">
        <Button variant="icon" aria-label={collapsed ? "Expand thread" : "Collapse thread"} onClick={(event) => { event.stopPropagation(); setCollapsed(!collapsed); }}>{collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</Button>
        <div className={onJump != null ? "thread-title-link" : undefined} {...jumpProps}><strong>{title}</strong><span>{subtitle}</span>{status != null && <span className={`thread-status ${status.toLowerCase()}`}>{status}</span>}</div>
      </div>
      <div className="actions">
        <a href={href} target="_blank" rel="noreferrer" className="thread-github-link" onClick={(event) => event.stopPropagation()}><LinkExternalIcon size={14} /></a>
      </div>
    </div>
    {!collapsed && body}
  </div>;
}

function ThreadReplyBox({ prUrl, kind, commentId, refreshGithubActivity }: { prUrl: string; kind: "issue" | "review"; commentId?: number; refreshGithubActivity: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  async function submitReply() {
    if (body.trim().length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api("/api/comment/reply", { method: "POST", body: JSON.stringify({ prUrl, kind, commentId, body }) });
      setBody("");
      await refreshGithubActivity();
    } finally {
      setSubmitting(false);
    }
  }
  return <div className="thread-reply thread-reply-box"><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reply…" aria-label="Reply to thread" /><Button variant="muted" onClick={() => void submitReply()} disabled={submitting || body.trim().length === 0}>{submitting ? "Replying…" : "Reply"}</Button></div>;
}

export function ExistingComments({ prUrl, comments, issueComments, reviewSummaries, refreshGithubActivity, collapseSignal, commentsCollapsed, toggleAllComments, onJumpToComment }: { prUrl: string; comments: PullReviewComment[]; issueComments: PullIssueComment[]; reviewSummaries: PullRequestReviewSummary[]; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; toggleAllComments: () => void; onJumpToComment?: (target: ReturnType<typeof commentTarget>) => void }) {
  const [reviewerFilter, setReviewerFilter] = useState("");
  const reviewThreads = groupReviewComments(comments);
  const reviewer = reviewerHandle(reviewerFilter);
  const allComments = [...comments, ...issueComments, ...reviewSummaries];
  const reviewers = reviewerOptions(allComments);
  const filteredReviewSummaries = reviewSummaries.filter((review) => commentIncludesReviewer(review, reviewer));
  const filteredIssueComments = threadIncludesReviewer(issueComments, reviewer) ? issueComments : [];
  const filteredReviewThreads = reviewThreads.filter((thread) => threadIncludesReviewer(thread, reviewer));
  const visibleCount = filteredReviewThreads.reduce((count, thread) => count + thread.length, filteredIssueComments.length + filteredReviewSummaries.length);
  const totalCount = comments.length + issueComments.length + reviewSummaries.length;
  const toggleLabel = commentsCollapsed ? "Expand all" : "Collapse all";
  return <section className="panel"><div className="section-head"><h2>Existing comments</h2>{totalCount > 0 && <Button variant="muted" className="small-muted-button" onClick={toggleAllComments}>{toggleLabel}</Button>}</div>{totalCount === 0 ? <p className="muted">No existing comments.</p> : <><div className="comment-filter"><label>Filter @<input value={reviewerFilter} onChange={(event) => setReviewerFilter(event.target.value)} placeholder="reviewer" /></label>{reviewerFilter.trim().length > 0 && <Button variant="muted" className="small-muted-button" onClick={() => setReviewerFilter("")}>Clear</Button>}<span className="muted">{reviewer.length === 0 ? `${totalCount} shown` : `${visibleCount}/${totalCount} shown`}</span></div>{reviewers.length > 0 && <div className="reviewer-chips">{reviewers.map((login) => <button type="button" key={login} className={reviewer === login.toLowerCase() ? "active" : ""} onClick={() => setReviewerFilter(`@${login}`)}>@{login}</button>)}</div>}{visibleCount === 0 ? <p className="muted">No comments match @{reviewer}.</p> : <>{filteredReviewSummaries.map((review) => <GitHubThreadCard key={review.id} title="Review summary" subtitle={review.state.toLowerCase().replace("_", " ")} href={review.html_url} comments={[review]} commentKind="review-summary" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} />)}{filteredIssueComments.length > 0 && <GitHubThreadCard title="Conversation thread" subtitle={commentCountLabel(filteredIssueComments.length)} href={filteredIssueComments[0].html_url} comments={filteredIssueComments} commentKind="issue" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} reply={<ThreadReplyBox prUrl={prUrl} kind="issue" refreshGithubActivity={refreshGithubActivity} />} />}{filteredReviewThreads.map((thread) => { const target = commentTarget(thread[0]); return <GitHubThreadCard key={thread.map((comment) => comment.id).join(":")} title="Review thread" subtitle={`${targetLabel(target)} · ${commentCountLabel(thread.length)}`} status={resolvedLabel(thread)} href={thread[0].html_url} comments={thread} commentKind="review" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={thread[0].id} refreshGithubActivity={refreshGithubActivity} />} onJump={onJumpToComment != null ? () => onJumpToComment(target) : undefined} />; })}</>}</>}</section>;
}
