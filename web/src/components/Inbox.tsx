import { AlertIcon, BellSlashIcon, CheckCircleFillIcon, CheckIcon, CommentIcon, DotFillIcon, EyeIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, InboxIcon, IssueOpenedIcon, LinkExternalIcon, MentionIcon, PersonIcon, SyncIcon, XCircleFillIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, errorMessage, logUsage } from "../api";
import { relativeTime } from "../lib/pr";
import type { InboxItem, InboxResponse, InboxTier, ViewerPullRequest } from "../types";
import { Button } from "./Button";

type TierFilter = InboxTier | "all";

const TIER_META: Record<InboxTier, { label: string; hint: string }> = {
  "needs-you": { label: "Needs you", hint: "Direct mentions, assignments, and approvals someone is waiting on." },
  "review-requests": { label: "Review requests", hint: "Open, non-draft PRs where your review was requested." },
  "your-prs": { label: "Your PRs", hint: "Activity on pull requests you authored." },
  fyi: { label: "FYI", hint: "Comments, subscriptions, and drafts you can skim later." },
  resolved: { label: "Resolved", hint: "The PR or issue is already merged or closed." },
};
const TIER_ORDER: InboxTier[] = ["needs-you", "review-requests", "your-prs", "fyi", "resolved"];
/** Served from the server's snapshot, so polling is cheap; the server decides when GitHub is re-read. */
const POLL_IDLE_MS = 60 * 1000;
const POLL_REFRESHING_MS = 1500;
const SCOPE_HINT = "gh auth refresh -h github.com -s notifications";

function reasonIcon(item: InboxItem): ReactNode {
  switch (item.reason) {
    case "mention":
    case "team_mention":
      return <MentionIcon size={16} />;
    case "review_requested":
      return <EyeIcon size={16} />;
    case "author":
      return <PersonIcon size={16} />;
    case "assign":
      return <AlertIcon size={16} />;
    default:
      return item.kind === "issue" ? <IssueOpenedIcon size={16} /> : item.kind === "pr" ? <GitPullRequestIcon size={16} /> : <CommentIcon size={16} />;
  }
}

function itemFlags(item: InboxItem): Array<{ label: string; tone: "danger" | "success" | "attention" | "muted" }> {
  const flags: Array<{ label: string; tone: "danger" | "success" | "attention" | "muted" }> = [];
  if (item.state === "MERGED") flags.push({ label: "merged", tone: "muted" });
  else if (item.state === "CLOSED") flags.push({ label: "closed", tone: "muted" });
  if (item.isDraft) flags.push({ label: "draft", tone: "muted" });
  if (item.checks === "FAILURE" || item.checks === "ERROR") flags.push({ label: "CI failing", tone: "danger" });
  else if (item.checks === "PENDING") flags.push({ label: "CI running", tone: "attention" });
  if (item.reviewDecision === "APPROVED") flags.push({ label: "approved", tone: "success" });
  else if (item.reviewDecision === "CHANGES_REQUESTED") flags.push({ label: "changes requested", tone: "attention" });
  return flags;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") != null;
}

type MyPrView = "open" | "closed";

function needsAttention(pr: ViewerPullRequest): boolean {
  return pr.checks === "FAILURE" || pr.checks === "ERROR" || pr.mergeable === "CONFLICTING" || pr.reviewDecision === "CHANGES_REQUESTED";
}

/** Repos ordered by their most recent PR activity; PRs inside a repo stay newest-first. */
function groupByRepo(prs: ViewerPullRequest[]): Array<{ repo: string; prs: ViewerPullRequest[] }> {
  const byRepo = new Map<string, ViewerPullRequest[]>();
  for (const pr of [...prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const list = byRepo.get(pr.repo) ?? [];
    list.push(pr);
    byRepo.set(pr.repo, list);
  }
  return [...byRepo.entries()].map(([repo, list]) => ({ repo, prs: list }));
}

function myPrStatus(pr: ViewerPullRequest): { icon: ReactNode; tone: "danger" | "success" | "attention" | "muted"; details: string[] } {
  const details: string[] = [];
  if (pr.state === "MERGED") return { icon: <GitMergeIcon size={14} />, tone: "success", details: [`merged ${relativeTime(pr.closedAt)}`] };
  if (pr.state === "CLOSED") return { icon: <GitPullRequestClosedIcon size={14} />, tone: "danger", details: [`closed ${relativeTime(pr.closedAt)}`] };
  if (pr.mergeable === "CONFLICTING") details.push("merge conflicts");
  if (pr.checks === "FAILURE" || pr.checks === "ERROR") details.push(pr.failingChecks.length > 0 ? `${pr.failingChecks.length} failing check${pr.failingChecks.length === 1 ? "" : "s"}` : "CI failing");
  else if (pr.checks === "PENDING") details.push("CI running");
  else if (pr.checks === "SUCCESS") details.push("CI green");
  if (pr.reviewDecision === "APPROVED") details.push("approved");
  else if (pr.reviewDecision === "CHANGES_REQUESTED") details.push("changes requested");
  else if (pr.reviewers.length > 0) details.push(`awaiting ${pr.reviewers.slice(0, 2).join(", ")}${pr.reviewers.length > 2 ? ` +${pr.reviewers.length - 2}` : ""}`);
  else if (!pr.isDraft) details.push("no reviewers");
  if (pr.mergeable === "CONFLICTING" || pr.checks === "FAILURE" || pr.checks === "ERROR") return { icon: <XCircleFillIcon size={14} />, tone: "danger", details };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { icon: <GitPullRequestClosedIcon size={14} />, tone: "attention", details };
  if (pr.isDraft) return { icon: <GitPullRequestDraftIcon size={14} />, tone: "muted", details };
  if (pr.reviewDecision === "APPROVED" && pr.checks === "SUCCESS") return { icon: <GitMergeIcon size={14} />, tone: "success", details };
  if (pr.checks === "PENDING") return { icon: <DotFillIcon size={14} />, tone: "attention", details };
  if (pr.checks === "SUCCESS") return { icon: <CheckCircleFillIcon size={14} />, tone: "success", details };
  return { icon: <GitPullRequestIcon size={14} />, tone: "muted", details };
}

/**
 * Home-page triage inbox: GitHub notifications ranked into tiers on the left,
 * the viewer's own open PRs on the right. Rows are triaged with the keyboard
 * (←/e done, →/enter open, m mute, j/k move) or the hover actions, and every
 * done/mute writes through to GitHub so the real inbox shrinks too.
 */
export function InboxPanel({ openPr }: { openPr: (url: string) => Promise<void> }) {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TierFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLUListElement | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setLoading(true);
    try {
      const response = await api<InboxResponse>(`/api/inbox${refresh ? "?refresh=1" : ""}`);
      setData(response);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshing = data?.refreshing ?? false;
  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, refreshing ? POLL_REFRESHING_MS : POLL_IDLE_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshing]);

  const items = data?.items ?? [];
  const visible = useMemo(() => (filter === "all" ? items.filter((item) => item.tier !== "resolved") : items.filter((item) => item.tier === filter)), [items, filter]);
  const resolvedIds = useMemo(() => items.filter((item) => item.tier === "resolved").map((item) => item.id), [items]);
  const counts = data?.tiers ?? { "needs-you": 0, "review-requests": 0, "your-prs": 0, fyi: 0, resolved: 0 };
  const selected = visible.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selected == null && visible.length > 0) setSelectedId(visible[0].id);
  }, [selected, visible]);

  useEffect(() => {
    if (selectedId == null) return;
    listRef.current?.querySelector<HTMLElement>(`[data-inbox-id="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function removeLocally(ids: string[]): void {
    const gone = new Set(ids);
    setData((current) => {
      if (current == null) return current;
      const remaining = current.items.filter((item) => !gone.has(item.id));
      const tiers = { ...current.tiers };
      for (const item of current.items) if (gone.has(item.id)) tiers[item.tier] = Math.max(0, tiers[item.tier] - 1);
      return { ...current, items: remaining, tiers };
    });
    if (selectedId != null && gone.has(selectedId)) {
      const index = visible.findIndex((item) => item.id === selectedId);
      const next = visible.slice(index + 1).find((item) => !gone.has(item.id)) ?? visible.slice(0, index).reverse().find((item) => !gone.has(item.id)) ?? null;
      setSelectedId(next?.id ?? null);
    }
  }

  async function runAction(path: "/api/inbox/done" | "/api/inbox/mute", ids: string[], usage: string): Promise<void> {
    if (ids.length === 0) return;
    setBusyIds((current) => new Set([...current, ...ids]));
    setActionError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify({ threadIds: ids }) });
      removeLocally(ids);
      logUsage(usage, { count: ids.length });
    } catch (err) {
      const message = errorMessage(err);
      setActionError(message.includes("notifications") && message.includes("scope") ? `${message} — run: ${SCOPE_HINT}` : message);
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }

  function openItem(item: InboxItem): void {
    logUsage("inbox:open", { tier: item.tier, reason: item.reason, kind: item.kind });
    if (item.kind === "pr") {
      void openPr(item.url);
      void runAction("/api/inbox/done", [item.id], "inbox:done-on-open");
      return;
    }
    window.open(item.url, "_blank", "noopener");
  }

  function openOnGitHub(item: InboxItem): void {
    window.open(item.latest?.url ?? item.url, "_blank", "noopener");
  }

  function moveSelection(delta: number): void {
    if (visible.length === 0) return;
    const index = Math.max(0, visible.findIndex((item) => item.id === selectedId));
    setSelectedId(visible[Math.min(visible.length - 1, Math.max(0, index + delta))].id);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSelection(-1);
      } else if (selected == null) {
        return;
      } else if (event.key === "ArrowLeft" || event.key === "e") {
        event.preventDefault();
        void runAction("/api/inbox/done", [selected.id], "inbox:done");
      } else if (event.key === "ArrowRight" || event.key === "Enter" || event.key === "o") {
        event.preventDefault();
        openItem(selected);
      } else if (event.key === "m") {
        event.preventDefault();
        void runAction("/api/inbox/mute", [selected.id], "inbox:mute");
      } else if (event.key === "g") {
        event.preventDefault();
        openOnGitHub(selected);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const total = items.length;
  const freshness = data == null ? "" : data.fetchedAt == null ? "loading from GitHub…" : refreshing ? `updated ${relativeTime(data.fetchedAt)} · refreshing…` : `updated ${relativeTime(data.fetchedAt)}`;
  const summary = data == null ? null : data.fetchedAt == null ? freshness : total === 0 ? `Inbox zero · ${freshness}` : `${total} unread · ${counts["needs-you"]} need you · ${counts["review-requests"]} review requests · ${freshness}`;

  return <section className="inbox" aria-label="GitHub inbox">
    <header className="inbox-head">
      <h2><InboxIcon size={16} /> Inbox</h2>
      {summary != null && <span className="inbox-summary">{summary}</span>}
      <div className="inbox-head-actions">
        {resolvedIds.length > 0 && <Button variant="muted" onClick={() => void runAction("/api/inbox/done", resolvedIds, "inbox:clear-resolved")} disabled={resolvedIds.some((id) => busyIds.has(id))}>Clear {resolvedIds.length} resolved</Button>}
        <Button variant="muted" className={`inbox-refresh${loading || refreshing ? " loading" : ""}`} onClick={() => void load(true)} disabled={loading || refreshing} aria-label="Refresh inbox"><SyncIcon size={14} /> Refresh</Button>
      </div>
    </header>
    {error != null && <p className="inbox-error" role="alert">Could not load notifications: {error}{error.includes("scope") ? <> Run <code>{SCOPE_HINT}</code>.</> : null}</p>}
    {actionError != null && <p className="inbox-error" role="alert">{actionError}</p>}
    {data?.warnings.map((warning) => <p key={warning} className="inbox-warning">{warning}</p>)}
    <div className="inbox-body">
      <div className="inbox-list-panel">
        <nav className="inbox-tiers" aria-label="Filter inbox by tier">
          <button type="button" className={`inbox-tier${filter === "all" ? " active" : ""}`} onClick={() => setFilter("all")}>All<span className="inbox-tier-count">{total - counts.resolved}</span></button>
          {TIER_ORDER.map((tier) => <button key={tier} type="button" className={`inbox-tier tier-${tier}${filter === tier ? " active" : ""}`} title={TIER_META[tier].hint} onClick={() => setFilter(tier)}><DotFillIcon size={12} className="inbox-tier-dot" />{TIER_META[tier].label}<span className="inbox-tier-count">{counts[tier]}</span></button>)}
        </nav>
        {data == null || (data.fetchedAt == null && refreshing) ? <ul className="inbox-rows inbox-skeleton" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <li key={index} className="inbox-row skeleton"><span className="inbox-skeleton-bar icon" /><span className="inbox-skeleton-lines"><span className="inbox-skeleton-bar" style={{ width: `${55 + (index % 3) * 12}%` }} /><span className="inbox-skeleton-bar short" /></span></li>)}</ul>
          : visible.length === 0 ? <div className="inbox-empty">{data == null ? "Inbox unavailable." : total === 0 ? <><CheckIcon size={24} /><p>Inbox zero. Nothing on GitHub is waiting on you.</p></> : <p className="muted">Nothing in {filter === "all" ? "the active tiers" : TIER_META[filter].label.toLowerCase()}.</p>}</div>
            : <ul className="inbox-rows" ref={listRef}>
              {visible.map((item) => {
                const busy = busyIds.has(item.id);
                const flags = itemFlags(item);
                return <li key={item.id} data-inbox-id={item.id} className={`inbox-row tier-${item.tier}${item.id === selectedId ? " selected" : ""}${busy ? " busy" : ""}`} onClick={() => setSelectedId(item.id)} onDoubleClick={() => openItem(item)}>
                  <span className="inbox-row-icon" title={item.reason.replace(/_/g, " ")}>{reasonIcon(item)}</span>
                  <div className="inbox-row-main">
                    <div className="inbox-row-head">
                      <a className="inbox-row-title" href={item.url} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); openItem(item); }}>{item.title}</a>
                      {flags.length > 0 && <span className="inbox-row-flags">{flags.map((flag) => <span key={flag.label} className={`inbox-flag ${flag.tone}`}>{flag.label}</span>)}</span>}
                    </div>
                    <div className="inbox-row-meta">
                      <span className="inbox-row-ref">{item.repo}{item.number != null ? `#${item.number}` : ""}</span>
                      {item.author != null && item.reason !== "author" && <span>by {item.author}</span>}
                      <span>{item.why.join(" · ")}</span>
                      <span>{relativeTime(item.updatedAt)}</span>
                      {item.localPrKey != null && <span className="inbox-row-local">reviewed here</span>}
                    </div>
                    {item.latest != null && item.latest.snippet.length > 0 && <div className={`inbox-row-latest${item.latest.bot ? " bot" : ""}`}><strong>@{item.latest.author ?? "unknown"}</strong> {item.latest.snippet}</div>}
                  </div>
                  <div className="inbox-row-actions">
                    <Button variant="icon" title="Done (←)" aria-label={`Mark ${item.title} done`} disabled={busy} onClick={(event) => { event.stopPropagation(); void runAction("/api/inbox/done", [item.id], "inbox:done"); }}><CheckIcon size={16} /></Button>
                    <Button variant="icon" title="Mute thread (m)" aria-label={`Mute ${item.title}`} disabled={busy} onClick={(event) => { event.stopPropagation(); void runAction("/api/inbox/mute", [item.id], "inbox:mute"); }}><BellSlashIcon size={16} /></Button>
                    <Button variant="icon" title="Open on GitHub (g)" aria-label={`Open ${item.title} on GitHub`} onClick={(event) => { event.stopPropagation(); openOnGitHub(item); }}><LinkExternalIcon size={16} /></Button>
                  </div>
                </li>;
              })}
            </ul>}
        <footer className="inbox-footer">
          <span><kbd>j</kbd><kbd>k</kbd> move · <kbd>←</kbd> done · <kbd>→</kbd> open · <kbd>m</kbd> mute · <kbd>g</kbd> GitHub</span>
          <span>{visible.length} shown</span>
        </footer>
      </div>
      <MyPullRequests open={data?.myPrs ?? []} closed={data?.recentlyClosedPrs ?? []} loading={data == null || (data.fetchedAt == null && refreshing)} login={data?.login ?? null} />
    </div>
  </section>;
}

const COLLAPSED_REPOS_KEY = "pi-review-my-prs-collapsed";

function readCollapsedRepos(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_REPOS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((repo): repo is string => typeof repo === "string") : []);
  } catch {
    return new Set();
  }
}

function MyPullRequests({ open, closed, loading, login }: { open: ViewerPullRequest[]; closed: ViewerPullRequest[]; loading: boolean; login: string | null }) {
  const [view, setView] = useState<MyPrView>("open");
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(readCollapsedRepos);
  function toggleRepo(repo: string): void {
    setCollapsedRepos((current) => {
      const next = new Set(current);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      localStorage.setItem(COLLAPSED_REPOS_KEY, JSON.stringify([...next]));
      return next;
    });
  }
  const prs = view === "open" ? open : closed;
  const groups = useMemo(() => groupByRepo(prs), [prs]);
  const attention = open.filter(needsAttention).length;
  return <aside className="my-prs-panel" aria-label="Your pull requests">
    <header className="my-prs-head">
      <h3><GitPullRequestIcon size={14} /> Your PRs</h3>
      <div className="my-prs-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === "open"} className={`my-prs-tab${view === "open" ? " active" : ""}`} onClick={() => setView("open")}>Open <span className="my-prs-tab-count">{open.length}</span></button>
        <button type="button" role="tab" aria-selected={view === "closed"} className={`my-prs-tab${view === "closed" ? " active" : ""}`} onClick={() => setView("closed")}>Closed <span className="my-prs-tab-count">{closed.length}</span></button>
      </div>
      <span className="muted my-prs-summary">{loading ? "Loading…" : view === "open" ? (attention > 0 ? `${attention} need attention` : login == null ? "" : "all green") : "last 14 days"}</span>
    </header>
    <div className="my-prs-body">
      {!loading && prs.length === 0 && <p className="my-prs-empty muted">{view === "open" ? "No open pull requests." : "Nothing merged or closed in the last 14 days."}</p>}
      {groups.map((group) => {
        const broken = view === "open" ? group.prs.filter(needsAttention).length : 0;
        const collapsed = collapsedRepos.has(group.repo);
        return <section key={group.repo} className={`my-prs-group${collapsed ? " collapsed" : ""}`}>
          <h4 className="kicker my-prs-group-head">
            <button type="button" className="my-prs-group-toggle" aria-expanded={!collapsed} onClick={() => toggleRepo(group.repo)}><span className="disclosure-chevron" aria-hidden="true">›</span><span className="my-prs-group-repo">{group.repo}</span><span className="my-prs-group-count">{group.prs.length}</span></button>
            {broken > 0 && <span className="my-prs-group-broken">{broken} need attention</span>}
          </h4>
          {!collapsed && group.prs.map((pr) => {
            const status = myPrStatus(pr);
            return <a key={pr.key} className={`my-pr-row${view === "open" && needsAttention(pr) ? " attention" : ""}`} href={pr.url} target="_blank" rel="noopener" title={pr.failingChecks.length > 0 ? `Failing: ${pr.failingChecks.slice(0, 5).join("\n")}` : undefined}>
              <span className={`my-pr-status status-${status.tone}`}>{status.icon}</span>
              <span className="my-pr-body">
                <span className="my-pr-title">{pr.title}</span>
                <span className="my-pr-meta"><span>#{pr.number}</span>{pr.isDraft && pr.state === "OPEN" && <span>draft</span>}{status.details.map((detail) => <span key={detail}>{detail}</span>)}<span>{relativeTime(pr.updatedAt)}</span></span>
              </span>
            </a>;
          })}
        </section>;
      })}
    </div>
  </aside>;
}
