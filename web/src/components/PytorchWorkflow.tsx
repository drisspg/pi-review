import { BellSlashIcon, CheckIcon, GearIcon, IssueOpenedIcon, LinkExternalIcon, SyncIcon, ThumbsupIcon, XIcon } from "@primer/octicons-react";
import { Radio, Textarea, TextInput } from "@primer/react";
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";

import { api, errorMessage, logUsage } from "../api";
import { relativeTime } from "../lib/pr";
import type { InboxItem, PytorchAssessment, PytorchPrStatus, PytorchQueueIssue, PytorchQueuePr, PytorchQueuesResponse, PytorchStageInfo, StoredPullRequest } from "../types";
import { Button } from "./Button";
import { ModalShell } from "./Modal";

/**
 * PyTorch's label-driven PR/issue workflow (maintainer guide): pre-review and full-review
 * queues for the viewer, the per-module issue triage queues, and one-click workflow actions.
 * All GitHub writes go through /api/pytorch/*, which validates them against the workflow.
 */

type QueueTab = "pre-review" | "review" | "issues";
type DeclineTarget = { number: number; title: string; text?: string; outcome?: DeclineOutcome };
type DeclineOutcome = "draft" | "close";
type TriageLabel = "needs reproduction" | "needs research" | "needs design" | "actionable" | "won't fix";

/** Queue searches are cached server-side for 5 min; polling also picks up live issue notifications. */
const POLL_IDLE_MS = 60 * 1000;
const POLL_REFRESHING_MS = 3000;
/** While the background assessor works, poll a little faster so new suggestions appear promptly. */
const POLL_ASSESSING_MS = 15 * 1000;
const TRIAGE_ACTIONS: Array<{ label: TriageLabel; short: string; hint: string }> = [
  { label: "needs reproduction", short: "Repro", hint: "Not reproduced yet; anyone can reproduce, a maintainer validates." },
  { label: "needs research", short: "Research", hint: "Undecided whether the bug is real or the feature is wanted." },
  { label: "needs design", short: "Design", hint: "Worth doing, but the approach is not settled." },
  { label: "actionable", short: "Actionable", hint: "Enough detail for anyone to send a good PR, and you will review it." },
];
const DECLINE_TEMPLATES: Array<{ id: string; label: string; outcome: DeclineOutcome; text: string }> = [
  { id: "design", label: "Needs design discussion", outcome: "close", text: "Closing this PR because it requires a design discussion that we should continue on the issue. Please comment on the linked issue with a summary of the status and approach to further discuss." },
  { id: "justification", label: "Not enough justification", outcome: "close", text: "Closing this PR because the description does not give enough justification for a quick decision. Please describe the problem and why it matters on an issue, and wait for a maintainer to mark it `actionable`." },
  { id: "clarify", label: "Minor clarification", outcome: "draft", text: "Thanks for the PR! Before this moves on, could you clarify in the description: " },
];

function stageTone(stage: PytorchStageInfo, viewerActs: boolean): string {
  if (stage.stage === "merged" || stage.stage === "closed") return "done";
  if (stage.needsSendBack) return "attention";
  if (stage.actor === "reviewers") return viewerActs ? "accent" : "muted";
  if (stage.stage === "missing-issue") return "danger";
  if (stage.stage === "accepted") return "success";
  return "muted";
}

function plainOpen(event: MouseEvent, action: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  action();
}

function prSize(pr: PytorchQueuePr): string {
  return `+${pr.additions}/−${pr.deletions} in ${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}`;
}

function LinkedIssues({ pr }: { pr: PytorchQueuePr }) {
  const mentioned = pr.mentionedIssues.map((number) => <a key={`m${number}`} className="pt-issue-chip mentioned" href={`https://github.com/pytorch/pytorch/issues/${number}`} target="_blank" rel="noreferrer" title="Mentioned in the description but not a closing reference, so its labels are unknown">mentions #{number}</a>);
  if (pr.linkedIssues.length === 0 && mentioned.length === 0) return <span className="pt-issue-chip none" title="No issue reference; the author needs write access or a named sponsoring maintainer">no linked issue</span>;
  return <>{mentioned}{pr.linkedIssues.map((issue) => <a key={issue.number} className={`pt-issue-chip${issue.actionable ? " actionable" : ""}`} href={issue.url} target="_blank" rel="noreferrer" title={`${issue.title}\n${issue.labels.join(", ")}`}><IssueOpenedIcon size={12} />#{issue.number}{issue.actionable ? " actionable" : ""}</a>)}</>;
}

const RECOMMENDATION_LABEL: Record<PytorchAssessment["recommendation"], string> = { accept: "Accept", draft: "Back to draft", close: "Close" };

/** Decline target prefilled from a saved suggestion, so acting on it is review-and-confirm. */
function declineFromAssessment(pr: { number: number; title: string }, assessment: PytorchAssessment | null): DeclineTarget {
  if (assessment == null || assessment.recommendation === "accept") return { number: pr.number, title: pr.title };
  return { number: pr.number, title: pr.title, text: assessment.comment ?? undefined, outcome: assessment.recommendation };
}

/** Saved AI pre-review suggestion: verdict + one-line reason, expandable to evidence and the drafted comment. */
function AssessmentSummary({ assessment }: { assessment: PytorchAssessment }) {
  return <details className={`pt-assessment rec-${assessment.recommendation}`}>
    <summary>
      <span className="disclosure-chevron" aria-hidden="true">›</span>
      <span className="pt-assessment-badge">{assessment.source}: {RECOMMENDATION_LABEL[assessment.recommendation]}</span>
      <span className="pt-assessment-why">{assessment.why}</span>
      {assessment.outdated && <span className="inbox-flag attention" title={`Assessed ${new Date(assessment.assessedAt).toLocaleString()}; the PR changed since`}>PR updated since</span>}
    </summary>
    <div className="pt-assessment-body">
      {assessment.preconditions != null && <p><strong>Pre-conditions:</strong> {assessment.preconditions}</p>}
      {assessment.notes.length > 0 && <ul>{assessment.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {assessment.comment != null && <blockquote className="pt-assessment-comment">{assessment.comment}</blockquote>}
      <p className="muted">Assessed {relativeTime(assessment.assessedAt)} · suggestion only; nothing is posted until you confirm.</p>
    </div>
  </details>;
}

/** Shared reason composer: the guide asks maintainers to always explain declines and won't-fix. */
function ReasonDialog({ open, title, submitLabel, initialText, initialOutcome, outcomes, templates, onCancel, onSubmit }: { open: boolean; title: string; submitLabel: (outcome: DeclineOutcome | null) => string; initialText?: string; initialOutcome?: DeclineOutcome; outcomes: boolean; templates?: typeof DECLINE_TEMPLATES; onCancel: () => void; onSubmit: (reason: string, outcome: DeclineOutcome | null) => Promise<void> }) {
  const [text, setText] = useState(initialText ?? "");
  const [outcome, setOutcome] = useState<DeclineOutcome>(initialOutcome ?? "close");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setText(initialText ?? "");
    setOutcome(initialOutcome ?? "close");
    setError(null);
  }, [open, initialText, initialOutcome]);
  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text, outcomes ? outcome : null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return <ModalShell open={open} onOpenChange={(next) => { if (!next) onCancel(); }} label={title} className="pt-reason-modal">
    <div className="pi-modal-head"><h2>{title}</h2></div>
    <div className="pi-modal-body pt-reason-body">
      {templates != null && <div className="pt-templates" role="group" aria-label="Reason templates">{templates.map((template) => <Button key={template.id} variant="muted" onClick={() => { setText(template.text); setOutcome(template.outcome); }}>{template.label}</Button>)}</div>}
      <Textarea block rows={5} value={text} aria-label="Reason" onChange={(event) => setText(event.target.value)} placeholder="Explain the reason to the author (posted as a comment)" />
      {outcomes && <div className="pt-outcomes" role="radiogroup" aria-label="Outcome">
        <label><Radio name="pt-outcome" value="draft" checked={outcome === "draft"} onChange={() => setOutcome("draft")} /> Move back to draft <span className="muted">— minor clarification needed</span></label>
        <label><Radio name="pt-outcome" value="close" checked={outcome === "close"} onChange={() => setOutcome("close")} /> Close <span className="muted">— design discussion or justification belongs on the issue; links “Why was my PR closed?”</span></label>
      </div>}
      {error != null && <p className="inbox-error" role="alert">{error}</p>}
    </div>
    <div className="pi-modal-foot">
      <Button variant="muted" onClick={onCancel}>Cancel</Button>
      <Button className="pi-primary" disabled={busy || text.trim().length === 0} onClick={() => void submit()}>{busy ? "Posting…" : submitLabel(outcomes ? outcome : null)}</Button>
    </div>
  </ModalShell>;
}


async function declinePreReview(target: DeclineTarget, reason: string, outcome: DeclineOutcome): Promise<void> {
  await api("/api/pytorch/pre-review/decline", { method: "POST", body: JSON.stringify({ number: target.number, outcome, reason }) });
  logUsage("pytorch:pre-review-decline", { outcome });
}

function ModuleEditor({ modules, onSaved, onCancel }: { modules: string[]; onSaved: (modules: string[]) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(modules);
  const [input, setInput] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api<{ labels: string[] }>("/api/pytorch/module-labels").then((response) => setLabels(response.labels)).catch((err: unknown) => setError(`Could not load module labels: ${errorMessage(err)}`));
  }, []);
  function add(value: string): void {
    const label = value.trim();
    if (label.length === 0 || draft.includes(label)) return;
    setDraft([...draft, label]);
    setInput("");
  }
  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const response = await api<{ modules: string[] }>("/api/pytorch/modules", { method: "POST", body: JSON.stringify({ modules: draft }) });
      logUsage("pytorch:modules", { count: response.modules.length });
      onSaved(response.modules);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return <div className="pt-module-editor">
    <p className="muted">Modules you own. Each gets a triage queue: issues labeled <code>triaged</code> + the module, without a full-triage label yet.</p>
    <div className="pt-module-chips">
      {draft.length === 0 && <span className="muted">No modules yet.</span>}
      {draft.map((module) => <span key={module} className="pt-module-chip">{module}<button type="button" aria-label={`Remove ${module}`} onClick={() => setDraft(draft.filter((item) => item !== module))}><XIcon size={12} /></button></span>)}
    </div>
    <form className="pt-module-add" onSubmit={(event) => { event.preventDefault(); add(input); }}>
      <TextInput list="pt-module-labels" value={input} onChange={(event) => setInput(event.target.value)} placeholder="module: autograd" aria-label="Add module label" />
      <datalist id="pt-module-labels">{labels.filter((label) => !draft.includes(label)).map((label) => <option key={label} value={label} />)}</datalist>
      <Button variant="muted" type="submit" disabled={input.trim().length === 0}>Add</Button>
      <span className="pt-module-actions">
        <Button variant="muted" onClick={onCancel}>Cancel</Button>
        <Button className="pi-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save modules"}</Button>
      </span>
    </form>
    {error != null && <p className="inbox-error" role="alert">{error}</p>}
  </div>;
}

/** Home-page panel: the three maintainer queues from the PyTorch maintainer guide. */
export function PytorchQueuesPanel({ openPr }: { openPr: (url: string) => Promise<void> }) {
  const [data, setData] = useState<PytorchQueuesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<QueueTab>("pre-review");
  const [busy, setBusy] = useState<Set<number>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [editingModules, setEditingModules] = useState(false);
  const [decline, setDecline] = useState<DeclineTarget | null>(null);
  const [wontFix, setWontFix] = useState<PytorchQueueIssue | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    try {
      setData(await api<PytorchQueuesResponse>(`/api/pytorch/queues${refresh ? "?refresh=1" : ""}`));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  const refreshing = data?.refreshing ?? false;
  const assessing = data?.assessor?.current != null;
  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, refreshing ? POLL_REFRESHING_MS : assessing ? POLL_ASSESSING_MS : POLL_IDLE_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshing, assessing]);

  async function act(number: number, work: () => Promise<void>): Promise<void> {
    setBusy((current) => new Set(current).add(number));
    setActionError(null);
    try {
      await work();
      await load(false);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(number);
        return next;
      });
    }
  }

  const accept = (pr: PytorchQueuePr) => act(pr.number, async () => {
    await api("/api/pytorch/pre-review/accept", { method: "POST", body: JSON.stringify({ number: pr.number }) });
    logUsage("pytorch:pre-review-accept", { from: "queue" });
  });
  const sendBack = (pr: PytorchQueuePr) => act(pr.number, async () => {
    await api("/api/pytorch/pr/send-back", { method: "POST", body: JSON.stringify({ number: pr.number }) });
    logUsage("pytorch:send-back", { from: "queue" });
  });
  async function notificationAction(ids: string[], action: "done" | "mute"): Promise<void> {
    setActionError(null);
    try {
      await api(`/api/inbox/${action}`, { method: "POST", body: JSON.stringify({ threadIds: ids }) });
      logUsage(`pytorch:issue-notification-${action}`, { count: ids.length });
      await load(false);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }
  const triage = (issue: PytorchQueueIssue, label: TriageLabel, comment?: string) => act(issue.number, async () => {
    await api("/api/pytorch/issue/triage", { method: "POST", body: JSON.stringify({ number: issue.number, label, comment }) });
    logUsage("pytorch:triage", { label });
  });

  const owedPreReviews = data?.preReview.items.filter((pr) => !pr.viewerThumbsUp).length ?? 0;
  const triageItems = data?.triage.reduce((sum, entry) => sum + entry.total, 0) ?? 0;
  const activeNotifications = data?.issueNotifications.filter((item) => item.tier !== "resolved") ?? [];
  const resolvedNotificationIds = data?.issueNotifications.filter((item) => item.tier === "resolved").map((item) => item.id) ?? [];
  const overdue = useMemo(() => data?.triage.reduce((sum, entry) => sum + entry.items.filter((issue) => issue.overdue).length, 0) ?? 0, [data]);
  const tabs: Array<{ id: QueueTab; label: string; count: number; hint: string }> = [
    { id: "pre-review", label: "Pre-review", count: owedPreReviews, hint: "Triaged PRs awaiting your direction check. 👍 the description to accept; aim for under a minute each." },
    { id: "review", label: "Review", count: data?.review.total ?? 0, hint: "PRs labeled ready for review where you are a requested reviewer. Review as usual." },
    { id: "issues", label: "Issues", count: activeNotifications.length + triageItems, hint: "pytorch/pytorch issue notifications, then your modules' issues still needing a full-triage label (SLA: one week)." },
  ];
  const githubUrl = tab === "pre-review" ? data?.preReview.githubUrl : tab === "review" ? data?.review.githubUrl : undefined;
  const freshness = data?.fetchedAt == null ? "loading from GitHub…" : `updated ${relativeTime(data.fetchedAt)}${refreshing ? " · refreshing…" : ""}`;

  function prRow(pr: PytorchQueuePr, kind: "pre-review" | "review") {
    const isBusy = busy.has(pr.number);
    const open = expanded.has(pr.number);
    return <li key={pr.number} className={`inbox-row pt-row${isBusy ? " busy" : ""}${pr.viewerThumbsUp && kind === "pre-review" ? " pt-accepted" : ""}`}>
      <span className={`pt-stage-dot tone-${stageTone(pr.stage, true)}`} title={`${pr.stage.label}: ${pr.stage.next}`} />
      <div className="inbox-row-main">
        <div className="inbox-row-head">
          <a className="inbox-row-title" href={pr.url} onClick={(event) => plainOpen(event, () => { logUsage("pytorch:open", { queue: kind }); void openPr(pr.url); })}>{pr.title}</a>
          <span className="inbox-row-flags">
            {pr.stage.highPriority && <span className="inbox-flag danger">high priority</span>}
            {(pr.checks === "FAILURE" || pr.checks === "ERROR") && <span className="inbox-flag danger">CI failing</span>}
            {pr.stage.needsSendBack && <span className="inbox-flag attention">changes requested</span>}
            {pr.viewerThumbsUp && kind === "pre-review" && <span className="inbox-flag success">you accepted · waiting on other reviewers</span>}
          </span>
        </div>
        <div className="inbox-row-meta">
          <span className="inbox-row-ref">#{pr.number}</span>
          {pr.author != null && <span>by {pr.author}</span>}
          <span title={`Opened ${new Date(pr.createdAt).toLocaleString()}`}>opened {relativeTime(pr.createdAt)}</span>
          <span>{prSize(pr)}</span>
          {pr.localPrKey != null && <span className="inbox-row-local">reviewed here</span>}
        </div>
        {kind === "pre-review" && pr.assessment != null && <AssessmentSummary assessment={pr.assessment} />}
        {kind === "pre-review" && <div className="pt-row-issues"><LinkedIssues pr={pr} /></div>}
        {kind === "pre-review" && pr.bodyExcerpt.length > 0 && <button type="button" className={`pt-excerpt${open ? " open" : ""}`} aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(pr.number)) next.delete(pr.number); else next.add(pr.number); return next; })}>{pr.bodyExcerpt}</button>}
        {kind === "pre-review" && pr.bodyExcerpt.length === 0 && <span className="pt-excerpt-empty">No description — the guide allows rejecting at pre-review for that.</span>}
      </div>
      <div className="pt-row-actions">
        {kind === "pre-review" && <>
          <Button variant="muted" disabled={isBusy || pr.viewerThumbsUp} title="React 👍 to the PR description (same as @pytorchbot pre-review accept)" onClick={() => void accept(pr)}><ThumbsupIcon size={14} /> {pr.viewerThumbsUp ? "Accepted" : "Accept"}</Button>
          <Button variant="muted" disabled={isBusy} title="Comment with a reason, then move to draft or close" onClick={() => setDecline(declineFromAssessment(pr, pr.assessment))}>Decline…</Button>
        </>}
        {kind === "review" && pr.stage.needsSendBack && <Button variant="muted" disabled={isBusy} title="TEMPORARY rule: after Request changes, re-add `in progress` so automated review runs again" onClick={() => void sendBack(pr)}>Send back to in progress</Button>}
        <Button variant="icon" title="Open on GitHub" aria-label={`Open #${pr.number} on GitHub`} onClick={() => window.open(pr.url, "_blank", "noopener")}><LinkExternalIcon size={16} /></Button>
      </div>
    </li>;
  }

  function issueRow(issue: PytorchQueueIssue) {
    const isBusy = busy.has(issue.number);
    const left = 7 - issue.ageDays;
    return <li key={issue.number} className={`inbox-row pt-row${isBusy ? " busy" : ""}`}>
      <span className={`pt-stage-dot tone-${issue.overdue ? "danger" : left <= 2 ? "attention" : "accent"}`} />
      <div className="inbox-row-main">
        <div className="inbox-row-head">
          <a className="inbox-row-title" href={issue.url} target="_blank" rel="noreferrer">{issue.title}</a>
          <span className="inbox-row-flags">
            {issue.highPriority && <span className="inbox-flag danger">high priority</span>}
            <span className={`inbox-flag${issue.overdue ? " danger" : left <= 2 ? " attention" : ""}`}>{issue.overdue ? `SLA overdue by ${issue.ageDays - 7}d` : `${left}d left to triage`}</span>
          </span>
        </div>
        <div className="inbox-row-meta">
          <span className="inbox-row-ref">#{issue.number}</span>
          {issue.author != null && <span>by {issue.author}</span>}
          <span>opened {relativeTime(issue.createdAt)}</span>
          <span>{issue.comments} comment{issue.comments === 1 ? "" : "s"}</span>
          {issue.assignees.length > 0 && <span>assigned {issue.assignees.join(", ")}</span>}
        </div>
      </div>
      <div className="pt-row-actions pt-triage-actions" role="group" aria-label={`Triage #${issue.number}`}>
        {TRIAGE_ACTIONS.map((action) => <Button key={action.label} variant="muted" disabled={isBusy} title={`Label "${action.label}": ${action.hint}`} onClick={() => void triage(issue, action.label)}>{action.short}</Button>)}
        <Button variant="muted" disabled={isBusy} title="Final state: valid but low ROI. Requires a comment explaining why." onClick={() => setWontFix(issue)}>Won’t fix…</Button>
        <Button variant="icon" title="Open on GitHub" aria-label={`Open issue #${issue.number} on GitHub`} onClick={() => window.open(issue.url, "_blank", "noopener")}><LinkExternalIcon size={16} /></Button>
      </div>
    </li>;
  }

  function notificationRow(item: InboxItem) {
    return <li key={item.id} className={`inbox-row pt-row tier-${item.tier}`}>
      <span className={`pt-stage-dot tone-${item.tier === "needs-you" ? "danger" : item.tier === "resolved" ? "done" : "muted"}`} />
      <div className="inbox-row-main">
        <div className="inbox-row-head">
          <a className="inbox-row-title" href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
          {item.state === "CLOSED" && <span className="inbox-row-flags"><span className="inbox-flag danger">closed</span></span>}
        </div>
        <div className="inbox-row-meta">
          <span className="inbox-row-ref">#{item.number}</span>
          {item.author != null && <span>by {item.author}</span>}
          <span>{item.why.join(" · ")}</span>
          <span>{relativeTime(item.updatedAt)}</span>
        </div>
        {item.latest != null && item.latest.snippet.length > 0 && <div className={`inbox-row-latest${item.latest.bot ? " bot" : ""}`}><strong>@{item.latest.author ?? "unknown"}</strong> {item.latest.snippet}</div>}
      </div>
      <div className="pt-row-actions">
        <Button variant="icon" title="Done" aria-label={`Mark ${item.title} done`} onClick={() => void notificationAction([item.id], "done")}><CheckIcon size={16} /></Button>
        <Button variant="icon" title="Mute thread" aria-label={`Mute ${item.title}`} onClick={() => void notificationAction([item.id], "mute")}><BellSlashIcon size={16} /></Button>
        <Button variant="icon" title="Open on GitHub" aria-label={`Open ${item.title} on GitHub`} onClick={() => window.open(item.latest?.url ?? item.url, "_blank", "noopener")}><LinkExternalIcon size={16} /></Button>
      </div>
    </li>;
  }

  const loading = data == null || (data.fetchedAt == null && refreshing);
  return <section className="inbox pt-queues" aria-label="PyTorch workflow queues">
    <header className="inbox-head">
      <h2><span className="pt-logo" aria-hidden="true">🔥</span> PyTorch queues</h2>
      <span className="inbox-summary">{data == null ? "" : `${owedPreReviews} pre-review · ${data.review.total} review · ${activeNotifications.length} issue notifications · ${triageItems} to triage${overdue > 0 ? ` (${overdue} past SLA)` : ""} · ${freshness}`}</span>
      <div className="inbox-head-actions">
        <Button variant="muted" onClick={() => setEditingModules(!editingModules)} aria-expanded={editingModules}><GearIcon size={14} /> Modules{data != null && data.modules.length > 0 ? ` (${data.modules.length})` : ""}</Button>
        <Button variant="muted" className={`inbox-refresh${refreshing ? " loading" : ""}`} onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh PyTorch queues"><SyncIcon size={14} /> Refresh</Button>
      </div>
    </header>
    {error != null && <p className="inbox-error" role="alert">Could not load PyTorch queues: {error}</p>}
    {actionError != null && <p className="inbox-error" role="alert">{actionError}</p>}
    {data?.warnings.map((warning) => <p key={warning} className="inbox-warning">{warning}</p>)}
    {editingModules && data != null && <ModuleEditor modules={data.modules} onCancel={() => setEditingModules(false)} onSaved={(modules) => { setEditingModules(false); setData({ ...data, modules, refreshing: true }); setTab("issues"); void load(false); }} />}
    <div className="inbox-list-panel">
      <nav className="inbox-tiers" aria-label="PyTorch queue">
        {tabs.map((item) => <button key={item.id} type="button" className={`inbox-tier${tab === item.id ? " active" : ""}`} title={item.hint} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>{item.label}<span className="inbox-tier-count">{item.count}</span></button>)}
        {tab === "pre-review" && data?.assessor?.enabled ? <span className={`pt-assessor-status${data.assessor.current != null ? " running" : ""}`} title={data.assessor.lastError != null ? `Last failure on #${data.assessor.lastError.number}: ${data.assessor.lastError.message}` : "One background agent pre-reviews owed PRs (most recently updated first) and saves suggestions. It never posts to GitHub."}>
          <span className="pt-assessor-dot" aria-hidden="true" />
          {data.assessor.current != null ? `${data.assessor.source} is pre-reviewing #${data.assessor.current.number} · ${Math.max(0, data.assessor.pending - 1)} more queued` : data.assessor.pending > 0 ? `${data.assessor.source}: ${data.assessor.pending} waiting for suggestions` : `${data.assessor.source} suggestions are up to date`}
          {data.assessor.lastError != null && <span className="pt-assessor-error"> · last failure #{data.assessor.lastError.number}</span>}
        </span> : <span className="pt-tab-hint muted">{tabs.find((item) => item.id === tab)?.hint}</span>}
      </nav>
      {loading ? <ul className="inbox-rows inbox-skeleton" aria-busy="true">{Array.from({ length: 3 }, (_, index) => <li key={index} className="inbox-row skeleton"><span className="inbox-skeleton-bar icon" /><span className="inbox-skeleton-lines"><span className="inbox-skeleton-bar" style={{ width: `${60 + index * 10}%` }} /><span className="inbox-skeleton-bar short" /></span></li>)}</ul>
        : tab === "pre-review" ? (data.preReview.items.length === 0 ? <div className="inbox-empty"><CheckIcon size={24} /><p>No PRs waiting on your pre-review.</p></div> : <ul className="inbox-rows">{data.preReview.items.map((pr) => prRow(pr, "pre-review"))}</ul>)
          : tab === "review" ? (data.review.items.length === 0 ? <div className="inbox-empty"><CheckIcon size={24} /><p>No PRs ready for your full review.</p></div> : <ul className="inbox-rows">{data.review.items.map((pr) => prRow(pr, "review"))}</ul>)
            : <div className="inbox-rows pt-triage-groups">
              <section className="pt-triage-group">
                <h4 className="kicker pt-triage-head"><span>Notifications</span><span className="pt-triage-count">{activeNotifications.length}</span>{resolvedNotificationIds.length > 0 && <button type="button" className="pt-link-button" onClick={() => void notificationAction(resolvedNotificationIds, "done")}>Clear {resolvedNotificationIds.length} closed</button>}</h4>
                {activeNotifications.length === 0 ? <p className="pt-triage-empty muted">No pytorch/pytorch issue notifications.</p> : <ul className="pt-triage-list">{activeNotifications.map(notificationRow)}</ul>}
              </section>
              {data.modules.length === 0 && <section className="pt-triage-group"><h4 className="kicker pt-triage-head"><span>Module triage</span></h4><p className="pt-triage-empty muted">Pick the modules you maintain to get their triage queues. <button type="button" className="pt-link-button" onClick={() => setEditingModules(true)}>Choose modules</button></p></section>}
              {data.triage.map((entry) => <section key={entry.module} className="pt-triage-group">
                <h4 className="kicker pt-triage-head"><span>{entry.module}</span><span className="pt-triage-count">{entry.items.length < entry.total ? `${entry.items.length} of ${entry.total}` : entry.total}</span><a href={entry.githubUrl} target="_blank" rel="noreferrer">GitHub <LinkExternalIcon size={12} /></a></h4>
                {entry.items.length === 0 ? <p className="pt-triage-empty muted">Fully triaged.</p> : <ul className="pt-triage-list">{entry.items.map(issueRow)}</ul>}
              </section>)}</div>}
      <footer className="inbox-footer">
        <span>{tab === "pre-review" ? "Direction check only: clear description · important problem · sound approach · reviewable size." : tab === "review" ? "Approving lets the author merge. Request changes → also send back to in progress." : "Only mark actionable if you will review the fix; won’t fix is final and needs a reason."}</span>
        {githubUrl != null && <a href={githubUrl} target="_blank" rel="noreferrer">Same search on GitHub <LinkExternalIcon size={12} /></a>}
      </footer>
    </div>
    <ReasonDialog open={decline != null} title={decline == null ? "Decline pre-review" : `Decline #${decline.number}`} outcomes templates={DECLINE_TEMPLATES} initialText={decline?.text} initialOutcome={decline?.outcome} submitLabel={(outcome) => outcome === "draft" ? "Comment & move to draft" : "Comment & close"} onCancel={() => setDecline(null)} onSubmit={async (reason, outcome) => {
      if (decline == null || outcome == null) return;
      const target = decline;
      await declinePreReview(target, reason, outcome);
      setDecline(null);
      await load(false);
    }} />
    <ReasonDialog open={wontFix != null} title={wontFix == null ? "Won't fix" : `Won't fix #${wontFix.number}`} outcomes={false} submitLabel={() => "Label won’t fix & comment"} onCancel={() => setWontFix(null)} onSubmit={async (reason) => {
      if (wontFix == null) return;
      const target = wontFix;
      await api("/api/pytorch/issue/triage", { method: "POST", body: JSON.stringify({ number: target.number, label: "won't fix", comment: reason }) });
      logUsage("pytorch:triage", { label: "won't fix" });
      setWontFix(null);
      await load(false);
    }} />
  </section>;
}

/** Review-page strip for pytorch/pytorch PRs: where the PR is in the workflow and the viewer's next action. */
export function PytorchWorkflowStrip({ pr }: { pr: StoredPullRequest }) {
  const [status, setStatus] = useState<PytorchPrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decline, setDecline] = useState<DeclineTarget | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<PytorchPrStatus>("/api/pytorch/pr-status", { method: "POST", body: JSON.stringify({ prUrl: pr.url }) }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [pr.url]);
  useEffect(() => {
    void load();
  }, [load, pr.headSha]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Checkout-free: the server fetches the description, conversation, linked issue and diff, then runs a tool-less model. */
  async function suggest(): Promise<void> {
    if (status == null) return;
    setSuggesting(true);
    setError(null);
    logUsage("pytorch:pre-review-suggest");
    try {
      await api("/api/pytorch/pre-review/assess", { method: "POST", body: JSON.stringify({ number: status.pr.number }) });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  if (status == null) return error == null ? null : <div className="pt-strip"><span className="muted">PyTorch workflow status unavailable: {error}</span></div>;
  const stage = status.pr.stage;
  const viewerActs = stage.actor === "reviewers" ? status.viewerIsReviewer : stage.actor === "author" && status.viewerIsAuthor;
  const canPreReview = stage.stage === "pre-review" && !status.viewerIsAuthor;
  const assessment = status.pr.assessment;
  return <div className="pt-strip" aria-label="PyTorch workflow">
    <span className={`pt-stage-pill tone-${stageTone(stage, viewerActs)}`} title="PyTorch PR workflow stage (CONTRIBUTING.md#pr-lifecycle)">{stage.label}</span>
    <span className="pt-strip-next">{viewerActs ? <strong>Your move: </strong> : <span className="muted">Next: </span>}{stage.next}</span>
    {stage.stage === "pre-review" && <span className="pt-strip-issues"><LinkedIssues pr={status.pr} /></span>}
    {stage.stale && <span className="inbox-flag attention">Stale</span>}
    <span className="pt-strip-actions">
      {canPreReview && <>
        <Button variant="muted" disabled={busy || status.pr.viewerThumbsUp} title="React 👍 to the PR description (same as @pytorchbot pre-review accept)" onClick={() => void run(async () => { await api("/api/pytorch/pre-review/accept", { method: "POST", body: JSON.stringify({ number: status.pr.number }) }); logUsage("pytorch:pre-review-accept", { from: "review" }); })}><ThumbsupIcon size={14} /> {status.pr.viewerThumbsUp ? "Pre-review accepted" : "Accept pre-review"}</Button>
        <Button variant="muted" disabled={busy} title="Comment with a reason, then move to draft or close" onClick={() => setDecline(declineFromAssessment(status.pr, assessment))}>Decline…</Button>
        <Button variant="muted" disabled={suggesting} title="Quick direction check from the description, conversation, linked issue and diff (no checkout); saved as a suggestion" onClick={() => void suggest()}>{suggesting ? "Assessing…" : assessment == null ? "Suggest pre-review" : "Re-assess"}</Button>
      </>}
      {stage.needsSendBack && !status.viewerIsAuthor && <Button variant="muted" disabled={busy} title="TEMPORARY rule: Request changes does not re-add `in progress` automatically yet" onClick={() => void run(async () => { await api("/api/pytorch/pr/send-back", { method: "POST", body: JSON.stringify({ number: status.pr.number }) }); logUsage("pytorch:send-back", { from: "review" }); })}>Send back to in progress</Button>}
    </span>
    {error != null && <span className="inbox-flag danger" role="alert">{error}</span>}
    {canPreReview && assessment != null && <div className="pt-strip-assessment"><AssessmentSummary assessment={assessment} /></div>}
    <ReasonDialog open={decline != null} title={decline == null ? "Decline pre-review" : `Decline #${decline.number}`} outcomes templates={DECLINE_TEMPLATES} initialText={decline?.text} initialOutcome={decline?.outcome} submitLabel={(outcome) => outcome === "draft" ? "Comment & move to draft" : "Comment & close"} onCancel={() => setDecline(null)} onSubmit={async (reason, outcome) => {
      if (decline == null || outcome == null) return;
      await declinePreReview(decline, reason, outcome);
      setDecline(null);
      await load();
    }} />
  </div>;
}
