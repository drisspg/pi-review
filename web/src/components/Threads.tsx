import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, KebabHorizontalIcon, LinkExternalIcon, ScreenFullIcon } from "@primer/octicons-react";

import { api } from "../api";
import { ActionMenu, ActionMenuItem } from "./ActionMenu";
import { Button } from "./Button";
import { ModalShell } from "./Modal";
import { commentTarget, groupReviewComments, targetLabel } from "../lib/comments";
import type { PullIssueComment, PullReviewComment } from "../types";
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

export function ExistingReviewThread({ comments, prUrl, refreshGithubActivity, collapseSignal = 0 }: { comments: PullReviewComment[]; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal?: number }) {
  const status = resolvedLabel(comments);
  return <GitHubThreadCard className="inline-thread existing" title="GitHub thread" subtitle={`${targetLabel(commentTarget(comments[0]))} · ${commentCountLabel(comments.length)}`} status={status} href={comments[0].html_url} comments={comments} collapseSignal={collapseSignal} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={comments[0].id} refreshGithubActivity={refreshGithubActivity} />} />;
}

function ReviewCommentTimeline({ comments }: { comments: Array<PullReviewComment | PullIssueComment> }) {
  return <div className="github-comment-timeline">{comments.map((comment) => { const login = comment.user?.login ?? "github"; return <div className={`github-comment commenter-${commenterTone(login)}`} key={comment.id}><div className="avatar" aria-hidden="true">{avatarLabel(login)}</div><div className="github-comment-body"><div className="github-comment-header"><strong>@{login}</strong></div><MarkdownText text={comment.body} /></div></div>; })}</div>;
}

function GitHubThreadCard({ className = "comment", title, subtitle, status, href, comments, reply, collapseSignal = 0 }: { className?: string; title: string; subtitle: string; status?: string | null; href: string; comments: Array<PullReviewComment | PullIssueComment>; reply?: React.ReactNode; collapseSignal?: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (collapseSignal > 0) setCollapsed(true);
  }, [collapseSignal]);
  const body = <><ReviewCommentTimeline comments={comments} />{reply}</>;
  return <>
    <div className={`${className} github-thread ${collapsed ? "minimized" : ""}`}>
      <div className="thread-head">
        <div className="thread-title">
          <Button variant="icon" aria-label={collapsed ? "Expand thread" : "Collapse thread"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</Button>
          <div><strong>{title}</strong><span>{subtitle}</span>{status != null && <span className={`thread-status ${status.toLowerCase()}`}>{status}</span>}</div>
        </div>
        <div className="actions">
          <Button variant="icon" className="subtle-icon-button" aria-label="Focus thread" onClick={() => setFocused(true)}><ScreenFullIcon size={16} /></Button>
          <ActionMenu trigger={<Button variant="icon" aria-label="Thread actions"><KebabHorizontalIcon size={16} /></Button>}>
            <ActionMenuItem asChild>
              <a href={href} target="_blank" rel="noreferrer"><LinkExternalIcon size={16} />Open on GitHub</a>
            </ActionMenuItem>
            <ActionMenuItem onSelect={() => setFocused(true)}><ScreenFullIcon size={16} />Focus thread</ActionMenuItem>
          </ActionMenu>
        </div>
      </div>
      {!collapsed && body}
    </div>
    <ModalShell open={focused} onOpenChange={setFocused} label={title} className="github-thread-modal">
      <div className="thread-head">
        <div><h2>{title}</h2><span>{subtitle}</span>{status != null && <span className={`thread-status ${status.toLowerCase()}`}>{status}</span>}</div>
        <div className="actions">
          <a href={href} target="_blank" rel="noreferrer"><LinkExternalIcon size={16} /> Open on GitHub</a>
          <Button variant="muted" onClick={() => setFocused(false)}>Close</Button>
        </div>
      </div>
      <div className="review-modal-body github-thread-dialog-body">{body}</div>
    </ModalShell>
  </>;
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
  return <div className="thread-reply"><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reply…" /><Button variant="muted" onClick={() => void submitReply()} disabled={submitting || body.trim().length === 0}>{submitting ? "Replying…" : "Reply"}</Button></div>;
}

export function ExistingComments({ prUrl, comments, issueComments, refreshGithubActivity, collapseSignal, collapseAllComments }: { prUrl: string; comments: PullReviewComment[]; issueComments: PullIssueComment[]; refreshGithubActivity: () => Promise<void>; collapseSignal: number; collapseAllComments: () => void }) {
  const reviewThreads = groupReviewComments(comments);
  return <section className="panel"><div className="section-head"><h2>Existing comments</h2>{comments.length + issueComments.length > 0 && <Button variant="muted" className="small-muted-button" onClick={collapseAllComments}>Collapse all</Button>}</div>{comments.length + issueComments.length === 0 ? <p className="muted">No existing comments.</p> : <>{issueComments.length > 0 && <GitHubThreadCard title="Conversation thread" subtitle={commentCountLabel(issueComments.length)} href={issueComments[0].html_url} comments={issueComments} collapseSignal={collapseSignal} reply={<ThreadReplyBox prUrl={prUrl} kind="issue" refreshGithubActivity={refreshGithubActivity} />} />}{reviewThreads.map((thread) => <GitHubThreadCard key={thread.map((comment) => comment.id).join(":")} title="Review thread" subtitle={`${targetLabel(commentTarget(thread[0]))} · ${commentCountLabel(thread.length)}`} status={resolvedLabel(thread)} href={thread[0].html_url} comments={thread} collapseSignal={collapseSignal} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={thread[0].id} refreshGithubActivity={refreshGithubActivity} />} />)}</>}</section>;
}
