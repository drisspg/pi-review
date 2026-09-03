import { useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, HubotIcon, LinkExternalIcon } from "@primer/octicons-react";
import { Flash, TextInput } from "@primer/react";

import { api, errorMessage } from "../api";
import { Button } from "./Button";
import { relativeTime } from "../lib/pr";
import { commentTarget, commentThreadDomId, groupReviewComments, targetLabel } from "../lib/comments";
import type { PullIssueComment, PullRequestReviewSummary, PullReviewComment } from "../types";
import { MarkdownText } from "./Markdown";
import { MarkdownEditor } from "./MarkdownEditor";

function commenterColor(login: string): string {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} ${(hash % 17) + 58}% ${(hash % 11) + 58}%)`;
}

function commentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

function resolvedLabel(comments: PullReviewComment[]): string | null {
  const resolved = comments.find((comment) => comment.thread_resolved != null)?.thread_resolved;
  return resolved == null ? null : resolved ? "Resolved" : "Unresolved";
}

const KNOWN_BOTS = new Set(["pytorchmergebot", "pytorch-bot", "facebook-github-bot", "github-actions", "dependabot", "codecov", "meta-codesync", "pytorchbot"]);

function isBotLogin(login: string): boolean {
  return login.endsWith("[bot]") || KNOWN_BOTS.has(login.toLowerCase());
}

/** One-line teaser for a folded bot comment: first meaningful text line, markup stripped. */
function commentPreview(body: string): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/:[a-z0-9_+-]+:/g, " ")
    .replace(/[#*_`>|]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  const preview = text.slice(0, 2).join(" · ");
  return preview.length > 140 ? `${preview.slice(0, 137)}…` : preview;
}

function reviewEventLabel(review: PullRequestReviewSummary): { verb: string; status: string | null } {
  switch (review.state) {
    case "APPROVED":
      return { verb: "approved these changes", status: "Approved" };
    case "CHANGES_REQUESTED":
      return { verb: "requested changes", status: "Changes requested" };
    case "DISMISSED":
      return { verb: "left a review that was dismissed", status: "Dismissed" };
    default:
      return { verb: "reviewed", status: null };
  }
}

function reviewerHandle(input: string): string {
  return input.trim().replace(/^@+/, "").toLowerCase();
}

type GitHubComment = PullReviewComment | PullIssueComment | PullRequestReviewSummary;
type CommentKind = "issue" | "review" | "review-summary";

function commentIncludesReviewer(comment: GitHubComment, reviewer: string): boolean {
  if (reviewer.length === 0) return true;
  const login = comment.user?.login?.toLowerCase();
  return login === reviewer || new RegExp(`(^|\\W)@${reviewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\W|$)`, "i").test(comment.body);
}

function threadIncludesReviewer(comments: GitHubComment[], reviewer: string): boolean {
  return comments.some((comment) => commentIncludesReviewer(comment, reviewer));
}

function reviewerOptions(comments: GitHubComment[]): string[] {
  const reviewers = new Set<string>();
  for (const comment of comments) {
    if (comment.user?.login != null) reviewers.add(comment.user.login);
    for (const match of comment.body.matchAll(/@([A-Za-z0-9-]+)/g)) reviewers.add(match[1]);
  }
  return [...reviewers].sort((a, b) => a.localeCompare(b));
}

export function ExistingReviewThread({ comments, prUrl, refreshGithubActivity, collapseSignal, collapseComments }: { comments: PullReviewComment[]; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; collapseComments: boolean }) {
  const target = commentTarget(comments[0]);
  const status = resolvedLabel(comments);
  const locationState = comments[0].line == null && comments[0].original_line != null ? " · Outdated" : "";
  return <GitHubThreadCard id={commentThreadDomId(target)} className="inline-thread existing" title="GitHub thread" subtitle={`${targetLabel(target)} · ${commentCountLabel(comments.length)}${locationState}`} status={status} href={comments[0].html_url} comments={comments} commentKind="review" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={collapseComments} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={comments[0].id} refreshGithubActivity={refreshGithubActivity} />} />;
}

function ReviewCommentTimeline({ comments, commentKind, prUrl, refreshGithubActivity }: { comments: GitHubComment[]; commentKind: CommentKind; prUrl: string; refreshGithubActivity: () => Promise<void> }) {
  // A review summary's card head already names the reviewer and verdict; a second header inside would repeat it.
  const headless = commentKind === "review-summary";
  return <div className={`github-comment-timeline${headless ? " headless" : ""}`}>{comments.map((comment) => <GitHubCommentView key={comment.id} comment={comment} commentKind={commentKind} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} headless={headless} />)}</div>;
}

function CommentEditor({ body, submitting, error, onChange, onCancel, onSave }: { body: string; submitting: boolean; error: string | null; onChange: (body: string) => void; onCancel: () => void; onSave: () => void }) {
  return <div className="github-comment-edit"><MarkdownEditor value={body} onChange={onChange} ariaLabel="Edit comment" autoFocus />{error != null && <Flash variant="danger" className="operation-error" role="alert">Edit failed: {error}</Flash>}<div className="github-comment-edit-actions"><Button variant="muted" onClick={onCancel} disabled={submitting}>Cancel</Button><Button className="composer-submit" onClick={onSave} disabled={submitting || body.trim().length === 0}>{submitting ? "Saving…" : error == null ? "Save" : "Retry"}</Button></div></div>;
}

function GitHubCommentView({ comment, commentKind, prUrl, refreshGithubActivity, headless = false }: { comment: GitHubComment; commentKind: CommentKind; prUrl: string; refreshGithubActivity: () => Promise<void>; headless?: boolean }) {
  const login = comment.user?.login ?? "github";
  const bot = isBotLogin(login);
  const timestamp = ("submitted_at" in comment ? comment.submitted_at : null) ?? comment.updated_at ?? null;
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bot output (CI summaries, merge logs) is reference material: fold it to one line until asked for.
  const [folded, setFolded] = useState(bot);
  async function saveEdit() {
    if (body.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/comment/edit", { method: "POST", body: JSON.stringify({ prUrl, kind: commentKind, commentId: comment.id, body }) });
      setEditing(false);
      void refreshGithubActivity();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }
  function startEditing() {
    setBody(comment.body);
    setError(null);
    setEditing(true);
    setFolded(false);
  }
  function cancelEditing() {
    setBody(comment.body);
    setError(null);
    setEditing(false);
  }
  const content = editing ? <CommentEditor body={body} submitting={submitting} error={error} onChange={setBody} onCancel={cancelEditing} onSave={() => void saveEdit()} /> : <MarkdownText text={body} />;
  if (headless) return <div className="github-comment headless"><div className="github-comment-body">{!editing && <Button variant="muted" className="small-muted-button github-comment-edit-button" onClick={startEditing}>Edit</Button>}{content}</div></div>;
  return <div className={`github-comment${bot ? " bot" : ""}${folded ? " folded" : ""}`} style={{ "--commenter": commenterColor(login) } as React.CSSProperties}>
    <div className="avatar" aria-hidden="true">{bot ? <HubotIcon size={16} /> : login.slice(0, 1).toUpperCase()}</div>
    <div className="github-comment-body">
      <div className="github-comment-header">
        <span className="github-comment-meta">
          <strong>{login}</strong>
          {timestamp != null && <span className="comment-time" title={new Date(timestamp).toLocaleString()}>commented {relativeTime(timestamp)}</span>}
          {folded && <span className="github-comment-preview">{commentPreview(body)}</span>}
        </span>
        <span className="github-comment-actions">
          {bot && <Button variant="muted" className="small-muted-button" aria-expanded={!folded} onClick={() => setFolded((current) => !current)}>{folded ? "Show" : "Hide"}</Button>}
          {!editing && !folded && <Button variant="muted" className="small-muted-button" onClick={startEditing}>Edit</Button>}
        </span>
      </div>
      {!folded && content}
    </div>
  </div>;
}

function GitHubThreadCard({ id, className = "comment", title, subtitle, status, href, comments, commentKind, prUrl, refreshGithubActivity, reply, collapseSignal, collapseComments, onJump }: { id?: string; className?: string; title: string; subtitle: string; status?: string | null; href: string; comments: GitHubComment[]; commentKind: CommentKind; prUrl: string; refreshGithubActivity: () => Promise<void>; reply?: React.ReactNode; collapseSignal: number; collapseComments: boolean; onJump?: () => void }) {
  // Resolved threads start compact: they are settled context, not active conversation.
  const resolved = status === "Resolved";
  const [collapsed, setCollapsed] = useState(resolved);
  useEffect(() => {
    if (resolved) setCollapsed(true);
  }, [resolved]);
  useEffect(() => {
    if (collapseSignal > 0) setCollapsed(collapseComments);
  }, [collapseSignal, collapseComments]);
  const body = <><ReviewCommentTimeline comments={comments} commentKind={commentKind} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} />{reply}</>;
  const titleAction = collapsed ? () => setCollapsed(false) : onJump;
  const titleActionProps = titleAction == null ? {} : { onClick: titleAction, role: "button", tabIndex: 0, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); titleAction(); } } };
  return <div id={id} className={`${className} github-thread ${collapsed ? "minimized" : ""}`}>
    <div className={`thread-head${titleAction != null ? " jumpable" : ""}`}>
      <div className="thread-title">
        <Button variant="icon" aria-label={collapsed ? "Expand thread" : "Collapse thread"} aria-expanded={!collapsed} title={collapsed ? "Expand GitHub thread" : "Collapse GitHub thread"} onClick={(event) => { event.stopPropagation(); setCollapsed(!collapsed); }}>{collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</Button>
        <div className={titleAction != null ? "thread-title-link" : undefined} {...titleActionProps}><strong>{title}</strong><span>{subtitle}</span>{status != null && <span className={`thread-status ${status.toLowerCase().replace(/\s+/g, "-")}`}>{status}</span>}</div>
      </div>
      <div className="actions">
        <a href={href} target="_blank" rel="noreferrer" className="thread-github-link" aria-label="Open thread on GitHub" title="Open thread on GitHub" onClick={(event) => event.stopPropagation()}><LinkExternalIcon size={14} /></a>
      </div>
    </div>
    {!collapsed && body}
  </div>;
}

function ThreadReplyBox({ prUrl, kind, commentId, refreshGithubActivity }: { prUrl: string; kind: "issue" | "review"; commentId?: number; refreshGithubActivity: () => Promise<void> }) {
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submitReply() {
    if (body.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("/api/comment/reply", { method: "POST", body: JSON.stringify({ prUrl, kind, commentId, body }) });
      setBody("");
      setComposing(false);
      await refreshGithubActivity();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }
  // Collapsed by default: a full editor under every thread makes the panel read like forms, not conversation.
  if (!composing) return <div className="thread-reply thread-reply-collapsed"><button type="button" className="thread-reply-trigger" onClick={() => setComposing(true)}>{body.trim().length > 0 ? "Continue reply…" : "Reply…"}</button></div>;
  return <div className="thread-reply thread-reply-box">
    <MarkdownEditor autoFocus value={body} onChange={setBody} placeholder="Reply…" ariaLabel="Reply to thread" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setComposing(false); } }} />
    {error != null && <Flash variant="danger" className="operation-error" role="alert">Reply failed: {error}</Flash>}
    <div className="thread-reply-actions">
      <Button variant="muted" onClick={() => setComposing(false)}>Cancel</Button>
      <Button className="composer-submit" onClick={() => void submitReply()} disabled={submitting || body.trim().length === 0}>{submitting ? "Replying…" : error == null ? "Reply" : "Retry"}</Button>
    </div>
  </div>;
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
  const inlineSummary = reviewThreads.length === 0 && totalCount > 0
    ? "No inline review threads. Conversation comments are shown here because GitHub does not attach them to file lines."
    : `${reviewThreads.length} inline review ${reviewThreads.length === 1 ? "thread" : "threads"} · ${issueComments.length} conversation ${issueComments.length === 1 ? "comment" : "comments"}`;
  return <section className="panel"><div className="section-head"><h2>Existing comments</h2>{totalCount > 0 && <Button variant="muted" className="small-muted-button" onClick={toggleAllComments}>{toggleLabel}</Button>}</div>{totalCount === 0 ? <p className="muted">No existing comments.</p> : <><p className="muted comment-placement-note">{inlineSummary}</p><div className="comment-filter"><label>Filter @<TextInput value={reviewerFilter} onChange={(event) => setReviewerFilter(event.target.value)} placeholder="reviewer" /></label>{reviewerFilter.trim().length > 0 && <Button variant="muted" className="small-muted-button" onClick={() => setReviewerFilter("")}>Clear</Button>}<span className="muted">{reviewer.length === 0 ? `${totalCount} shown` : `${visibleCount}/${totalCount} shown`}</span></div>{reviewers.length > 0 && <div className="reviewer-chips">{reviewers.map((login) => <button type="button" key={login} className={reviewer === login.toLowerCase() ? "active" : ""} onClick={() => setReviewerFilter(`@${login}`)}>@{login}</button>)}</div>}{visibleCount === 0 ? <p className="muted">No comments match @{reviewer}.</p> : <>{filteredReviewSummaries.map((review) => { const event = reviewEventLabel(review); return <GitHubThreadCard key={review.id} className={`comment review-event review-${review.state.toLowerCase()}`} title={`${review.user?.login ?? "Someone"} ${event.verb}`} subtitle={relativeTime(review.submitted_at ?? review.updated_at)} status={event.status} href={review.html_url} comments={[review]} commentKind="review-summary" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} />; })}{filteredIssueComments.length > 0 && <GitHubThreadCard title="Conversation" subtitle={commentCountLabel(filteredIssueComments.length)} href={filteredIssueComments[0].html_url} comments={filteredIssueComments} commentKind="issue" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} reply={<ThreadReplyBox prUrl={prUrl} kind="issue" refreshGithubActivity={refreshGithubActivity} />} />}{filteredReviewThreads.map((thread) => { const target = commentTarget(thread[0]); return <GitHubThreadCard key={thread.map((comment) => comment.id).join(":")} title={targetLabel(target)} subtitle={commentCountLabel(thread.length)} status={resolvedLabel(thread)} href={thread[0].html_url} comments={thread} commentKind="review" prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} reply={<ThreadReplyBox prUrl={prUrl} kind="review" commentId={thread[0].id} refreshGithubActivity={refreshGithubActivity} />} onJump={onJumpToComment != null ? () => onJumpToComment(target) : undefined} />; })}</>}</>}</section>;
}
