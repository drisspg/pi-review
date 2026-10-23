import { ArrowDownIcon, ArrowUpIcon, StackIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";

import { api } from "../api";

type MemberStatus = "landed" | "closed" | "approved" | "changes-requested" | "draft" | "needs-review";
type StackMember = { number: number; title: string; url: string; position: number; isCurrent: boolean; status: MemberStatus; additions: number; deletions: number; viewerReview: { state: string; freshness: "current" | "stale" } | null };
type StackView = { format: "sp" | "ghstack"; members: StackMember[]; currentPosition: number | null; nextToLand: number | null; counts: { total: number; landed: number; reviewedByViewer: number; approved: number } };

const STATUS_LABEL: Record<MemberStatus, string> = { landed: "landed", closed: "closed", approved: "approved", "changes-requested": "changes requested", draft: "draft", "needs-review": "needs review" };

function reviewMark(member: StackMember): string {
  if (member.viewerReview == null) return "";
  return member.viewerReview.freshness === "current" ? "✓" : "↻";
}

function describe(member: StackMember): string {
  const review = member.viewerReview == null ? "not reviewed by you" : `your ${member.viewerReview.state.toLowerCase().replace("_", " ")} review is ${member.viewerReview.freshness === "current" ? "at the current head" : "on an older revision"}`;
  return `#${member.number} ${member.title}\n${STATUS_LABEL[member.status]} · +${member.additions}/−${member.deletions} · ${review}`;
}

/**
 * Stacked-PR strip for the review header: every PR in the stack from bottom (lands first) to
 * top, the current one highlighted, with landed/review state at a glance and one-click hops.
 * Renders nothing for PRs that are not part of an sp/stack-pr or ghstack stack.
 */
export function StackStrip({ prUrl, headSha, hrefFor }: { prUrl: string; headSha: string; hrefFor: (url: string) => string }) {
  const [stack, setStack] = useState<StackView | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ stack: StackView | null }>("/api/pr/stack", { method: "POST", body: JSON.stringify({ prUrl }) })
      .then((response) => { if (!cancelled) setStack(response.stack); })
      .catch(() => { if (!cancelled) setStack(null); });
    return () => { cancelled = true; };
  }, [prUrl, headSha]);
  if (stack == null || stack.currentPosition == null) return null;
  const below = stack.members[stack.currentPosition - 1];
  const above = stack.members[stack.currentPosition + 1];
  const isBottomOpen = stack.nextToLand === stack.members[stack.currentPosition]?.number;
  return <nav className="stack-strip" aria-label="PR stack">
    <span className="stack-strip-label" title={`${stack.format === "ghstack" ? "ghstack" : "sp / stack-pr"} stack, bottom lands first`}>
      <StackIcon size={14} /> Stack {stack.currentPosition + 1}/{stack.counts.total}
      {isBottomOpen && <span className="stack-strip-next">lands next</span>}
    </span>
    <span className="stack-strip-hops">
      {below != null ? <a className="stack-hop" href={hrefFor(below.url)} title={`Below: ${describe(below)}`}><ArrowDownIcon size={12} /> #{below.number}</a> : <span className="stack-hop muted">bottom</span>}
      {above != null ? <a className="stack-hop" href={hrefFor(above.url)} title={`Above: ${describe(above)}`}><ArrowUpIcon size={12} /> #{above.number}</a> : <span className="stack-hop muted">top</span>}
    </span>
    <ol className="stack-chips">{stack.members.map((member) => <li key={member.number}>
      {member.isCurrent
        ? <span className={`stack-chip current status-${member.status}`} title={describe(member)} aria-current="page">#{member.number}<span className="stack-chip-mark">{reviewMark(member)}</span></span>
        : <a className={`stack-chip status-${member.status}`} href={hrefFor(member.url)} title={describe(member)}>#{member.number}<span className="stack-chip-mark">{reviewMark(member)}</span></a>}
    </li>)}</ol>
    <span className="stack-strip-summary muted">{stack.counts.landed} landed · {stack.counts.approved} approved{stack.counts.reviewedByViewer > 0 ? ` · ${stack.counts.reviewedByViewer} reviewed by you` : ""}{stack.nextToLand != null && !isBottomOpen ? ` · next to land #${stack.nextToLand}` : ""}</span>
  </nav>;
}
