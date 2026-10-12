import { ClockIcon, LinkExternalIcon } from "@primer/octicons-react";
import { useEffect, useMemo, useState } from "react";

import { api, errorMessage } from "../api";
import { relativeTime } from "../lib/pr";
import type { ActivityRange, ActivitySummary } from "../types";
import { Button } from "./Button";
import { ModalShell } from "./Modal";

const RANGES: Array<{ id: ActivityRange; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "year", label: "This year" },
  { id: "all", label: "All time" },
];

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms > 0 && minutes === 0) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

type Bucket = { label: string; title: string; activeMs: number; estimatedMs: number; reviews: number; preReviews: number; triage: number };

/** Bars of one metric per bucket (day or week); `max` normalizes heights within the chart. */
function TrendChart({ title, buckets, value, format, legend }: { title: string; buckets: Bucket[]; value: (bucket: Bucket) => { main: number; extra?: number }; format: (n: number) => string; legend?: boolean }) {
  const max = Math.max(1, ...buckets.map((bucket) => { const v = value(bucket); return v.main + (v.extra ?? 0); }));
  const total = buckets.reduce((sum, bucket) => sum + value(bucket).main, 0);
  return <section className="activity-days" aria-label={title}>
    <h3 className="kicker">{title} <span className="activity-chart-total">{format(total)} total</span></h3>
    <div className="activity-bars">{buckets.map((bucket) => {
      const v = value(bucket);
      return <div key={bucket.label} className="activity-day" title={`${bucket.title}: ${format(v.main)}${v.extra ? ` + ~${format(v.extra)} estimated` : ""} · ${bucket.reviews} reviews · ${bucket.preReviews} pre-reviews · ${bucket.triage} triaged`}>
        <div className="activity-bar-stack">
          {v.extra != null && <span className="activity-bar estimated" style={{ height: `${(v.extra / max) * 100}%` }} />}
          <span className="activity-bar measured" style={{ height: `${(v.main / max) * 100}%` }} />
        </div>
        <span className="activity-day-count">{v.main > 0 ? format(v.main) : ""}</span>
        <span className="activity-day-label">{bucket.label}</span>
      </div>;
    })}</div>
    {legend === true && <p className="muted activity-legend"><span className="activity-swatch measured" /> measured <span className="activity-swatch estimated" /> estimated</p>}
  </section>;
}

function useSummary(range: ActivityRange, refreshKey = 0): { data: ActivitySummary | null; error: string | null } {
  const [data, setData] = useState<ActivitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<ActivitySummary>(`/api/activity/summary?range=${range}`).then((next) => { if (!cancelled) { setData(next); setError(null); } }).catch((err: unknown) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [range, refreshKey]);
  return { data, error };
}

/** Compact start-page line: today's focused time and output, opening the full dashboard. */
export function ActivityBadge({ onOpen }: { onOpen: () => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const today = useSummary("today", tick).data;
  const week = useSummary("7d", tick).data;
  if (today == null || week == null) return null;
  const reviews = (summary: ActivitySummary) => summary.totals.reviews.APPROVE + summary.totals.reviews.REQUEST_CHANGES + summary.totals.reviews.COMMENT;
  const decisions = (summary: ActivitySummary) => summary.totals.preReview.accept + summary.totals.preReview.draft + summary.totals.preReview.close;
  return <button type="button" className="activity-badge" onClick={onOpen} title="Open review activity">
    <ClockIcon size={14} />
    <span><strong>Today</strong> {formatDuration(today.totals.activeMs)} focused · {reviews(today)} reviews · {decisions(today)} pre-reviews</span>
    <span className="muted" title="* includes estimated time from before precise tracking started">This week {formatDuration(week.totals.activeMs + week.totals.estimatedMs)}{week.totals.estimatedMs > 0 ? "*" : ""} · {reviews(week)} reviews</span>
  </button>;
}

/** Review activity dashboard: focused time, output, daily trend, and per-PR effort. */
export function ActivityModal({ close, openPr }: { close: () => void; openPr: (url: string) => void }) {
  const [range, setRange] = useState<ActivityRange>("7d");
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { data, error } = useSummary(range, refreshKey);
  async function syncNow(): Promise<void> {
    setSyncing(true);
    setSyncError(null);
    try {
      await api("/api/activity/sync", { method: "POST", body: "{}" });
      setRefreshKey((value) => value + 1);
    } catch (err) {
      setSyncError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }
  const totals = data?.totals;
  const reviewCount = totals == null ? 0 : totals.reviews.APPROVE + totals.reviews.REQUEST_CHANGES + totals.reviews.COMMENT;
  const weekly = range === "year" || range === "all";
  const buckets = useMemo<Bucket[]>(() => weekly
    ? (data?.weeks ?? []).map((week) => ({ ...week, label: week.weekStart.slice(5), title: `Week of ${week.weekStart}` }))
    : (data?.days ?? []).map((day) => ({ ...day, label: day.date.slice(5), title: day.date })), [data, weekly]);
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Review activity" className="pi-modal activity-modal">
    <div className="pi-modal-head">
      <div><h2>Review activity</h2><p className="muted">Focused time counts only while this app is visible, focused, and you interacted in the last 90 seconds.</p></div>
    </div>
    <div className="pi-modal-body activity-body">
      <nav className="activity-ranges" aria-label="Range">{RANGES.map((item) => <button key={item.id} type="button" className={`side-tab${range === item.id ? " active" : ""}`} aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.label}</button>)}</nav>
      {error != null && <p className="inbox-error" role="alert">{error}</p>}
      {data == null || totals == null ? <p className="muted">Loading…</p> : <>
        <div className="activity-cards">
          <div className="activity-card"><span className="kicker">Focused time</span><strong>{formatDuration(totals.activeMs)}</strong><span className="muted">reviewing {formatDuration(totals.reviewMs)} · queues/inbox {formatDuration(totals.homeMs)}</span>{totals.estimatedMs > 0 && <span className="activity-estimate">+ ~{formatDuration(totals.estimatedMs)} estimated before tracking</span>}</div>
          <div className="activity-card"><span className="kicker" title="One per PR per day, strongest verdict">Reviews submitted</span><strong>{reviewCount}</strong><span className="muted">{totals.reviews.APPROVE} approved · {totals.reviews.REQUEST_CHANGES} changes requested · {totals.reviews.COMMENT} commented</span><span className="muted">{totals.reviewsVia.piReview} via Pi Review · {totals.reviewsVia.githubOnly} on GitHub only</span>{totals.reviews.ARCHIVED > 0 && <span className="muted">{totals.reviews.ARCHIVED} archived locally</span>}</div>
          <div className="activity-card"><span className="kicker">Review comments</span><strong>{totals.reviewComments}</strong><span className="muted">{reviewCount > 0 ? `${(totals.reviewComments / reviewCount).toFixed(1)} per review` : "—"}</span></div>
          <div className="activity-card"><span className="kicker">Pre-review decisions</span><strong>{totals.preReview.accept + totals.preReview.draft + totals.preReview.close}</strong><span className="muted">{totals.preReview.accept} accepted · {totals.preReview.draft} to draft · {totals.preReview.close} closed</span></div>
          <div className="activity-card"><span className="kicker">Issues triaged</span><strong>{totals.triage}</strong><span className="muted">{totals.sendBack > 0 ? `${totals.sendBack} sent back to in progress` : "full-triage labels applied"}</span></div>
          <div className="activity-card"><span className="kicker">PRs touched</span><strong>{totals.prsTouched}</strong><span className="muted">{totals.avgMsPerReviewedPr == null ? "avg time per reviewed PR: not enough data yet" : `${formatDuration(totals.avgMsPerReviewedPr)} avg per reviewed PR`}</span></div>
        </div>
        {buckets.length > 0 && <>
          <TrendChart title={weekly ? "Reviews per week" : "Reviews per day"} buckets={buckets} value={(bucket) => ({ main: bucket.reviews })} format={(n) => String(n)} />
          <TrendChart title={weekly ? "Focused time per week" : "Focused time per day"} buckets={buckets} value={(bucket) => ({ main: bucket.activeMs, extra: bucket.estimatedMs })} format={formatDuration} legend />
        </>}
        <section aria-label="Per pull request">
          <h3 className="kicker">Per PR</h3>
          {data.prs.length === 0 ? <p className="muted">No review activity in this range yet.</p> : <table className="activity-table">
            <thead><tr><th>Pull request</th><th>Focused</th><th>Reviews</th><th>Workflow</th><th>Last</th></tr></thead>
            <tbody>{data.prs.map((pr) => <tr key={pr.prKey}>
              <td><a href={pr.url ?? undefined} onClick={(event) => { if (pr.url == null || !pr.url.includes("/pull/") || event.metaKey || event.ctrlKey) return; event.preventDefault(); close(); openPr(pr.url); }}>{pr.title}</a><span className="activity-pr-key">{pr.prKey.replace(/^github\.com\//, "")}</span></td>
              <td className="activity-num">{pr.ms > 0 ? formatDuration(pr.ms) : "—"}</td>
              <td>{pr.reviews.map((kind, index) => <span key={index} className={`activity-chip review-${kind.toLowerCase()}`}>{kind === "REQUEST_CHANGES" ? "changes" : kind.toLowerCase()}</span>)}{pr.comments > 0 && <span className="muted"> {pr.comments}💬</span>}</td>
              <td>{pr.actions.map((action, index) => <span key={index} className="activity-chip">{action.replace("pre-review:", "pre-review ").replace("triage:", "")}</span>)}</td>
              <td className="activity-num">{relativeTime(pr.lastAt)}</td>
            </tr>)}</tbody>
          </table>}
        </section>
        <p className="muted activity-footnote activity-sync">{data.github.enabled ? <>GitHub reviews {data.github.syncedAt == null ? "not synced yet" : <>synced {relativeTime(data.github.syncedAt)}{data.github.coveredFrom != null && <> · covering since {new Date(data.github.coveredFrom).toLocaleDateString()}</>}</>} · <button type="button" className="pt-link-button" disabled={syncing} onClick={() => void syncNow()}>{syncing ? "Syncing…" : "Sync now"}</button> · a year-to-date note is rewritten next to the ledger after each sync.</> : "GitHub review sync is off on this server, so only reviews submitted through Pi Review are counted."}{syncError != null && <span className="inbox-error"> {syncError}</span>}</p>
        <p className="muted activity-footnote">{data.trackingSince == null ? "Precise tracking starts with this version; " : `Measured since ${new Date(data.trackingSince).toLocaleDateString()}; `}earlier time is a lower-bound estimate from bursts of activity in the usage log (no per-PR attribution). A review is one PR per day with its strongest verdict (GitHub logs every thread reply as a separate review).</p>
      </>}
    </div>
    <div className="pi-modal-foot">
      <a className="muted" href="/api/activity/summary?range=all" target="_blank" rel="noreferrer">Raw JSON <LinkExternalIcon size={12} /></a>
      <Button variant="muted" onClick={close}>Close</Button>
    </div>
  </ModalShell>;
}
