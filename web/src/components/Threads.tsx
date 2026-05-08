import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, KebabHorizontalIcon, LinkExternalIcon, ScreenFullIcon } from "@primer/octicons-react";

import { api } from "../api";
import { commentTarget, groupReviewComments, targetLabel } from "../lib/comments";
import type { PullIssueComment, PullReviewComment } from "../types";
import { MarkdownText } from "./Markdown";

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

export function ExistingReviewThread({ comments, prUrl, refreshGithubActivity }: { comments: PullReviewComment[]; prUrl: string; refreshGithubActivity: () => Promise<void> }) {
  const status = resolvedLabel(comments);
  return <GitHubThreadCard className="inline-thread existing" title="GitHub thread" subtitle={`${targetLabel(commentTarget(comments[0]))} · ${commentCountLabel(comments.length)}`} status={status} href={comments[0].html_url} comments={comments} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={comments[0].id} refreshGithubActivity={refreshGithubActivity} />} />;
}

function ReviewCommentTimeline({ comments }: { comments: Array<PullReviewComment | PullIssueComment> }) {
  return <div className="github-comment-timeline">{comments.map((comment) => { const login = comment.user?.login ?? "github"; return <div className="github-comment" key={comment.id}><div className="avatar" aria-hidden="true">{avatarLabel(login)}</div><div className="github-comment-body"><div className="github-comment-header"><strong>@{login}</strong></div><MarkdownText text={comment.body} /></div></div>; })}</div>;
}

function GitHubThreadCard({ className = "comment", title, subtitle, status, href, comments, reply }: { className?: string; title: string; subtitle: string; status?: string | null; href: string; comments: Array<PullReviewComment | PullIssueComment>; reply?: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [focused, setFocused] = useState(false);
  const body = <><ReviewCommentTimeline comments={comments} />{reply}</>;
  return <><div className={`${className} github-thread ${collapsed ? "minimized" : ""}`}><div className="thread-head"><div className="thread-title"><button className="icon-button" aria-label={collapsed ? "Expand thread" : "Collapse thread"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</button><div><strong>{title}</strong><span>{subtitle}</span>{status != null && <span className={`thread-status ${status.toLowerCase()}`}>{status}</span>}</div></div><div className="actions"><button className="icon-button" aria-label="Focus thread" onClick={() => setFocused(true)}><ScreenFullIcon size={16} /></button><details className="action-menu"><summary aria-label="Thread actions"><KebabHorizontalIcon size={16} /></summary><div className="action-menu-popover"><a href={href} target="_blank" rel="noreferrer"><LinkExternalIcon size={16} />Open on GitHub</a><button onClick={() => setFocused(true)}><ScreenFullIcon size={16} />Focus thread</button></div></details></div></div>{!collapsed && body}</div>{focused && <div className="review-modal" role="dialog" aria-modal="true" aria-label={title}><div className="review-modal-card github-thread-modal"><div className="thread-head"><div><h2>{title}</h2><span>{subtitle}</span>{status != null && <span className={`thread-status ${status.toLowerCase()}`}>{status}</span>}</div><div className="actions"><a href={href} target="_blank" rel="noreferrer"><LinkExternalIcon size={16} /> Open on GitHub</a><button onClick={() => setFocused(false)}>Close</button></div></div><div className="review-modal-body github-thread-dialog-body">{body}</div></div></div>}</>;
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
  return <div className="thread-reply"><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reply…" /><button onClick={() => void submitReply()} disabled={submitting || body.trim().length === 0}>{submitting ? "Replying…" : "Reply"}</button></div>;
}

export function ExistingComments({ prUrl, comments, issueComments, refreshGithubActivity }: { prUrl: string; comments: PullReviewComment[]; issueComments: PullIssueComment[]; refreshGithubActivity: () => Promise<void> }) {
  const reviewThreads = groupReviewComments(comments);
  return <section className="panel"><h2>Existing comments</h2>{comments.length + issueComments.length === 0 ? <p className="muted">No existing comments.</p> : <>{issueComments.length > 0 && <GitHubThreadCard title="Conversation thread" subtitle={commentCountLabel(issueComments.length)} href={issueComments[0].html_url} comments={issueComments} reply={<ThreadReplyBox prUrl={prUrl} kind="issue" refreshGithubActivity={refreshGithubActivity} />} />}{reviewThreads.map((thread) => <GitHubThreadCard key={thread.map((comment) => comment.id).join(":")} title="Review thread" subtitle={`${targetLabel(commentTarget(thread[0]))} · ${commentCountLabel(thread.length)}`} status={resolvedLabel(thread)} href={thread[0].html_url} comments={thread} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={thread[0].id} refreshGithubActivity={refreshGithubActivity} />} />)}</>}</section>;
}
