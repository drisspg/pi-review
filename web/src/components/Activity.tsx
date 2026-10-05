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
  { id: "all", label: "All time" },
];

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms > 0 && minutes === 0) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
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
  const { data, error } = useSummary(range);
  const totals = data?.totals;
  const reviewCount = totals == null ? 0 : totals.reviews.APPROVE + totals.reviews.REQUEST_CHANGES + totals.reviews.COMMENT;
  const maxDayMs = useMemo(() => Math.max(1, ...(data?.days ?? []).map((day) => day.activeMs + day.estimatedMs)), [data]);
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
          <div className="activity-card"><span className="kicker">Reviews submitted</span><strong>{reviewCount}</strong><span className="muted">{totals.reviews.APPROVE} approved · {totals.reviews.REQUEST_CHANGES} changes requested · {totals.reviews.COMMENT} commented</span>{totals.reviews.ARCHIVED > 0 && <span className="muted">{totals.reviews.ARCHIVED} archived locally</span>}</div>
          <div className="activity-card"><span className="kicker">Review comments</span><strong>{totals.reviewComments}</strong><span className="muted">{reviewCount > 0 ? `${(totals.reviewComments / reviewCount).toFixed(1)} per review` : "—"}</span></div>
          <div className="activity-card"><span className="kicker">Pre-review decisions</span><strong>{totals.preReview.accept + totals.preReview.draft + totals.preReview.close}</strong><span className="muted">{totals.preReview.accept} accepted · {totals.preReview.draft} to draft · {totals.preReview.close} closed</span></div>
          <div className="activity-card"><span className="kicker">Issues triaged</span><strong>{totals.triage}</strong><span className="muted">{totals.sendBack > 0 ? `${totals.sendBack} sent back to in progress` : "full-triage labels applied"}</span></div>
          <div className="activity-card"><span className="kicker">PRs touched</span><strong>{totals.prsTouched}</strong><span className="muted">{totals.avgMsPerReviewedPr == null ? "avg time per reviewed PR: not enough data yet" : `${formatDuration(totals.avgMsPerReviewedPr)} avg per reviewed PR`}</span></div>
        </div>
        {data.days.length > 0 && <section className="activity-days" aria-label="Daily focused time">
          <h3 className="kicker">By day</h3>
          <div className="activity-bars">{data.days.map((day) => <div key={day.date} className="activity-day" title={`${day.date}: ${formatDuration(day.activeMs)} measured${day.estimatedMs > 0 ? `, ~${formatDuration(day.estimatedMs)} estimated` : ""} · ${day.reviews} reviews · ${day.preReviews} pre-reviews · ${day.triage} triaged`}>
            <div className="activity-bar-stack">
              <span className="activity-bar estimated" style={{ height: `${(day.estimatedMs / maxDayMs) * 100}%` }} />
              <span className="activity-bar measured" style={{ height: `${(day.activeMs / maxDayMs) * 100}%` }} />
            </div>
            <span className="activity-day-count">{day.reviews + day.preReviews + day.triage || ""}</span>
            <span className="activity-day-label">{day.date.slice(5)}</span>
          </div>)}</div>
          <p className="muted activity-legend"><span className="activity-swatch measured" /> measured <span className="activity-swatch estimated" /> estimated · number = reviews + pre-reviews + triage</p>
        </section>}
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
        <p className="muted activity-footnote">{data.trackingSince == null ? "Precise tracking starts with this version; " : `Measured since ${new Date(data.trackingSince).toLocaleDateString()}; `}earlier time is a lower-bound estimate from bursts of activity in the usage log (no per-PR attribution). Reviews come from your submitted/archived review history.</p>
      </>}
    </div>
    <div className="pi-modal-foot">
      <a className="muted" href="/api/activity/summary?range=all" target="_blank" rel="noreferrer">Raw JSON <LinkExternalIcon size={12} /></a>
      <Button variant="muted" onClick={close}>Close</Button>
    </div>
  </ModalShell>;
}
