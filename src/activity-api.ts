import type { ReviewMemoryRecord, StoredPullRequest } from "./types.js";

/**
 * Review activity ledger: how much focused time goes into reviewing and what came out of it.
 *
 * Measured data is an append-only JSONL ledger of (a) client heartbeats that only count time
 * while the tab is visible, focused, and recently interacted with, and (b) workflow actions the
 * server performed (pre-review decisions, triage labels, send-backs). Reviews merge Pi Review's
 * own history (reviewMemory) with the viewer's GitHub review contributions, synced daily and
 * backfilled up to a year, so reviews submitted directly on GitHub count too. A "review" is one
 * PR on one local day with its strongest verdict, because GitHub records every thread reply as a
 * separate COMMENTED review. Days before the ledger existed get an explicitly labeled time
 * estimate from bursts of interactive events in the usage log.
 */
export type ActivitySurface = "review" | "home";
export type ActivityAction = "pre-review:accept" | "pre-review:draft" | "pre-review:close" | "send-back" | `triage:${string}`;
export type ActivityRange = "today" | "7d" | "30d" | "year" | "all";
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/** One submitted review from the viewer's GitHub contributions (any client, not just Pi Review). */
export type GithubReview = { id: string; prKey: string; title: string; url: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"; at: string };
export type GithubReviewStore = { version: 1; syncedAt: string; coveredFrom: string; reviews: GithubReview[] };

type TimeEvent = { kind: "time"; at: string; ms: number; surface: ActivitySurface; prKey: string | null };
type ActionEvent = { kind: "action"; at: string; action: ActivityAction; prKey: string; title: string | null; url: string | null };
type LedgerEvent = TimeEvent | ActionEvent;

export type ActivityDay = { date: string; activeMs: number; estimatedMs: number; reviews: number; preReviews: number; triage: number };
/** Monday-start calendar week; `weekStart` is that Monday's local date. */
export type ActivityWeek = Omit<ActivityDay, "date"> & { weekStart: string };
export type ActivityPr = { prKey: string; title: string; url: string | null; ms: number; reviews: Array<ReviewVerdict | "ARCHIVED">; comments: number; actions: ActivityAction[]; lastAt: string };
export type ActivitySummary = {
  range: ActivityRange;
  from: string | null;
  generatedAt: string;
  /** First measured heartbeat; earlier time is estimated. */
  trackingSince: string | null;
  totals: {
    activeMs: number;
    reviewMs: number;
    homeMs: number;
    estimatedMs: number;
    reviews: { APPROVE: number; REQUEST_CHANGES: number; COMMENT: number; ARCHIVED: number };
    /** Where submitted reviews (PR-days) happened: through Pi Review, or only on GitHub. */
    reviewsVia: { piReview: number; githubOnly: number };
    reviewComments: number;
    preReview: { accept: number; draft: number; close: number };
    triage: number;
    sendBack: number;
    prsTouched: number;
    /** Mean measured time on PRs that received a submitted review in range; null until there is data. */
    avgMsPerReviewedPr: number | null;
  };
  days: ActivityDay[];
  weeks: ActivityWeek[];
  prs: ActivityPr[];
  github: { syncedAt: string | null; coveredFrom: string | null; enabled: boolean };
};

export type ActivityApiDeps = {
  readLedger: () => Promise<string>;
  appendLedger: (line: string) => Promise<void>;
  readUsageLog: () => Promise<string>;
  listReviewMemoryRecords: () => Promise<ReviewMemoryRecord[]>;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  now: () => string;
  /** Local calendar day for an instant; injectable so tests do not depend on the host time zone. */
  dayOf?: (iso: string) => string;
  /** Local midnight `daysAgo` days before `nowIso`. */
  startOfDay?: (nowIso: string, daysAgo: number) => string;
  /** Local midnight on January 1 of `nowIso`'s year. */
  startOfYear?: (nowIso: string) => string;
  /** The viewer's GitHub review contributions in [from, to]; absent when GitHub sync is disabled. */
  fetchGithubReviews?: (fromIso: string, toIso: string) => Promise<GithubReview[]>;
  readGithubReviews: () => Promise<GithubReviewStore | null>;
  writeGithubReviews: (store: GithubReviewStore) => Promise<void>;
  /** Readable year-to-date note (e.g. in a notes vault), rewritten after each sync. */
  writeReport?: (markdown: string) => Promise<void>;
};

export type ActivityApi = {
  heartbeat: (payload: Record<string, unknown>) => Promise<{ recorded: number }>;
  recordAction: (input: { action: ActivityAction; prKey: string; title?: string | null; url?: string | null }) => Promise<void>;
  summary: (range: string | null) => Promise<ActivitySummary>;
  /** Pull new GitHub reviews (daily unless forced) and rewrite the report. */
  sync: (options?: { force?: boolean }) => Promise<{ added: number; total: number; syncedAt: string | null; skipped: boolean }>;
};

const SYNC_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** GitHub's contributionsCollection spans at most one year per query. */
const BACKFILL_MS = 364 * 24 * 60 * 60 * 1000;
const SYNC_OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;
const VERDICT_RANK: Record<ReviewVerdict, number> = { COMMENT: 0, APPROVE: 1, REQUEST_CHANGES: 2 };

function githubVerdict(state: GithubReview["state"]): ReviewVerdict {
  return state === "APPROVED" ? "APPROVE" : state === "CHANGES_REQUESTED" ? "REQUEST_CHANGES" : "COMMENT";
}

/** Monday of the week containing a YYYY-MM-DD date; pure date math, independent of time zone. */
export function weekStartOf(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export function weeksFromDays(days: ActivityDay[]): ActivityWeek[] {
  const weeks = new Map<string, ActivityWeek>();
  for (const day of days) {
    const weekStart = weekStartOf(day.date);
    const week = weeks.get(weekStart) ?? { weekStart, activeMs: 0, estimatedMs: 0, reviews: 0, preReviews: 0, triage: 0 };
    week.activeMs += day.activeMs;
    week.estimatedMs += day.estimatedMs;
    week.reviews += day.reviews;
    week.preReviews += day.preReviews;
    week.triage += day.triage;
    weeks.set(weekStart, week);
  }
  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function verdictCount(totals: ActivitySummary["totals"]): number {
  return totals.reviews.APPROVE + totals.reviews.REQUEST_CHANGES + totals.reviews.COMMENT;
}

/** Year-to-date Markdown report for a notes vault: totals, monthly and weekly trend, top PRs. */
export function renderActivityReport(summary: ActivitySummary): string {
  const { totals } = summary;
  const months = new Map<string, ActivityWeek>();
  for (const day of summary.days) {
    const key = day.date.slice(0, 7);
    const month = months.get(key) ?? { weekStart: key, activeMs: 0, estimatedMs: 0, reviews: 0, preReviews: 0, triage: 0 };
    month.activeMs += day.activeMs;
    month.estimatedMs += day.estimatedMs;
    month.reviews += day.reviews;
    month.preReviews += day.preReviews;
    month.triage += day.triage;
    months.set(key, month);
  }
  const row = (label: string, entry: Omit<ActivityWeek, "weekStart">) => `| ${label} | ${entry.reviews} | ${entry.preReviews} | ${entry.triage} | ${hours(entry.activeMs)} | ${entry.estimatedMs > 0 ? `~${hours(entry.estimatedMs)}` : "—"} |`;
  const header = "| Period | Reviews | Pre-reviews | Triaged | Focused (measured) | Estimated |\n|---|---:|---:|---:|---:|---:|";
  const topPrs = [...summary.prs].filter((pr) => pr.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 15);
  return `# Review activity ${summary.generatedAt.slice(0, 4)}

_Generated ${summary.generatedAt.slice(0, 16).replace("T", " ")} UTC by Pi Review. Do not edit; it is rewritten after each sync._

## Year to date
- **Reviews:** ${verdictCount(totals)} (${totals.reviews.APPROVE} approved · ${totals.reviews.REQUEST_CHANGES} changes requested · ${totals.reviews.COMMENT} commented) — ${totals.reviewsVia.piReview} through Pi Review, ${totals.reviewsVia.githubOnly} directly on GitHub
- **Review comments drafted in Pi Review:** ${totals.reviewComments}
- **Pre-review decisions:** ${totals.preReview.accept + totals.preReview.draft + totals.preReview.close} (${totals.preReview.accept} accepted · ${totals.preReview.draft} to draft · ${totals.preReview.close} closed)
- **Issues triaged:** ${totals.triage}
- **Focused time in Pi Review:** ${hours(totals.activeMs)} measured${totals.estimatedMs > 0 ? ` + ~${hours(totals.estimatedMs)} estimated before precise tracking` : ""}
- **PRs touched:** ${totals.prsTouched}${totals.avgMsPerReviewedPr == null ? "" : ` · ${Math.round(totals.avgMsPerReviewedPr / 60_000)} min focused per reviewed PR`}

## By month
${header}
${[...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, month]) => row(key, month)).join("\n")}

## Last 12 weeks
${header}
${summary.weeks.slice(-12).map((week) => row(`wk of ${week.weekStart}`, week)).join("\n")}

## Most time spent (measured)
${topPrs.length === 0 ? "_No measured per-PR time yet._" : topPrs.map((pr) => `- [${pr.title.replace(/[[\]]/g, "")}](${pr.url ?? ""}) — ${Math.round(pr.ms / 60_000)} min${pr.reviews.length > 0 ? ` · ${pr.reviews.join(", ").toLowerCase()}` : ""}`).join("\n")}

## Method
- Reviews = one per PR per day, strongest verdict; from GitHub (any client${summary.github.coveredFrom == null ? ", not yet synced" : `, synced since ${summary.github.coveredFrom.slice(0, 10)}`}) merged with Pi Review history.
- Focused time counts only while Pi Review is visible, focused, and used in the last 90 s; time on GitHub or elsewhere is not measured, so it is a lower bound.
- Estimated time comes from bursts of activity in the usage log before precise tracking started${summary.trackingSince == null ? "" : ` (${summary.trackingSince.slice(0, 10)})`}.
`;
}

/**
 * Where the ledger lives: `PI_REVIEW_ACTIVITY_PATH`, else the machine-local `activityLedgerPath`
 * (only for the real, default-state server, so test/probe instances with a custom
 * PI_REVIEW_STATE_PATH never write into it), else next to the state file.
 */
export function resolveActivityLedgerPath(input: { env: NodeJS.ProcessEnv; configuredPath: string | undefined; defaultPath: string; home: string }): string {
  const expand = (path: string) => path.startsWith("~/") ? `${input.home}/${path.slice(2)}` : path;
  const fromEnv = input.env.PI_REVIEW_ACTIVITY_PATH?.trim();
  if (fromEnv) return expand(fromEnv);
  if (input.configuredPath != null && input.env.PI_REVIEW_STATE_PATH == null) return expand(input.configuredPath);
  return input.defaultPath;
}

/** One heartbeat may cover at most this much time, so a stuck or replayed client cannot inflate totals. */
export const MAX_HEARTBEAT_MS = 2 * 60 * 1000;
const PR_KEY = /^github\.com\/[\w.-]+\/[\w.-]+#\d+$/;
const ESTIMATE_GAP_MS = 10 * 60 * 1000;
const ESTIMATE_SESSION_CREDIT_MS = 3 * 60 * 1000;
/** Usage-log events that mean a person was actively doing something (polling and agent traffic excluded). */
const INTERACTIVE_SERVER_EVENTS = new Set(["/api/pr/open", "/api/draft-review/save", "/api/file/viewed", "/api/ask", "/api/ask/stream", "/api/pi/prompt", "/api/review/submit", "/api/review/archive", "/api/comment/reply", "/api/comment/resolve", "/api/comment/edit", "/api/inbox/done", "/api/inbox/mute", "/api/guide-review/progress", "/api/focus-scan/progress", "/api/pytorch/pre-review/accept", "/api/pytorch/pre-review/decline", "/api/pytorch/issue/triage", "/api/pytorch/pr/send-back"]);

function localDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localStartOfDay(nowIso: string, daysAgo: number): string {
  const date = new Date(nowIso);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

function parseLines<T>(text: string, accept: (value: unknown) => value is T): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (accept(value)) out.push(value);
    } catch {
      // A torn final line from a crash must not hide the rest of the history.
    }
  }
  return out;
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  const event = value as Partial<LedgerEvent> | null;
  if (event == null || typeof event.at !== "string") return false;
  if (event.kind === "time") return typeof event.ms === "number" && (event.surface === "review" || event.surface === "home");
  return event.kind === "action" && typeof event.action === "string" && typeof event.prKey === "string";
}

/** Sessionize interactive usage events: bursts separated by >10 min are separate sessions, each credited span + 3 min. */
export function estimateUsageSessions(usageText: string, before: string | null): Array<{ at: string; ms: number }> {
  const stamps = parseLines(usageText, (value): value is { ts: string; source: string; name: string } => {
    const event = value as { ts?: unknown; source?: unknown; name?: unknown } | null;
    return event != null && typeof event.ts === "string" && typeof event.name === "string" && (event.source === "web" || INTERACTIVE_SERVER_EVENTS.has(event.name));
  }).map((event) => event.ts).filter((ts) => before == null || ts < before).sort();
  const sessions: Array<{ at: string; ms: number }> = [];
  let start: string | null = null;
  let last: string | null = null;
  const close = () => {
    if (start != null && last != null) sessions.push({ at: start, ms: Date.parse(last) - Date.parse(start) + ESTIMATE_SESSION_CREDIT_MS });
  };
  for (const ts of stamps) {
    if (last != null && Date.parse(ts) - Date.parse(last) > ESTIMATE_GAP_MS) {
      close();
      start = ts;
    }
    start ??= ts;
    last = ts;
  }
  close();
  return sessions;
}

function parseRange(range: string | null): ActivityRange {
  return range === "today" || range === "7d" || range === "30d" || range === "year" || range === "all" ? range : "7d";
}

function localStartOfYear(nowIso: string): string {
  const date = new Date(nowIso);
  return new Date(date.getFullYear(), 0, 1).toISOString();
}

function prUrl(prKey: string): string | null {
  const match = /^github\.com\/([^#]+)#(\d+)$/.exec(prKey);
  return match == null ? null : `https://github.com/${match[1]}/pull/${match[2]}`;
}

export function createActivityApi(deps: ActivityApiDeps): ActivityApi {
  const dayOf = deps.dayOf ?? localDay;
  const startOfDay = deps.startOfDay ?? localStartOfDay;
  const startOfYear = deps.startOfYear ?? localStartOfYear;
  let syncing: Promise<{ added: number; total: number; syncedAt: string | null; skipped: boolean }> | null = null;
  let writes = Promise.resolve();
  let usageEstimate: { before: string | null; sessions: Array<{ at: string; ms: number }> } | null = null;

  function append(event: LedgerEvent): Promise<void> {
    writes = writes.then(() => deps.appendLedger(`${JSON.stringify(event)}\n`));
    return writes;
  }

  async function buildSummary(rawRange: string | null): Promise<ActivitySummary> {
      const range = parseRange(rawRange);
      const now = deps.now();
      const from = range === "all" ? null : range === "year" ? startOfYear(now) : startOfDay(now, range === "today" ? 0 : range === "7d" ? 6 : 29);
      const inRange = (at: string) => from == null || at >= from;
      await writes;
      const [ledgerText, memory, prs, githubStore] = await Promise.all([deps.readLedger().catch(() => ""), deps.listReviewMemoryRecords(), deps.listRecentPullRequests(), deps.readGithubReviews().catch(() => null)]);
      const ledger = parseLines(ledgerText, isLedgerEvent);
      const trackingSince = ledger.find((event) => event.kind === "time")?.at ?? null;
      // The usage log only grows and the estimate only covers time before measurement began, so it is computed once.
      if (usageEstimate == null || usageEstimate.before !== trackingSince) usageEstimate = { before: trackingSince, sessions: estimateUsageSessions(await deps.readUsageLog().catch(() => ""), trackingSince) };

      const titles = new Map(prs.map((pr) => [pr.key, { title: pr.title, url: pr.url }] as const));
      for (const review of githubStore?.reviews ?? []) if (!titles.has(review.prKey)) titles.set(review.prKey, { title: review.title, url: review.url });
      const days = new Map<string, ActivityDay>();
      const day = (at: string) => {
        const date = dayOf(at);
        let entry = days.get(date);
        if (entry == null) {
          entry = { date, activeMs: 0, estimatedMs: 0, reviews: 0, preReviews: 0, triage: 0 };
          days.set(date, entry);
        }
        return entry;
      };
      const byPr = new Map<string, ActivityPr>();
      const pr = (prKey: string, at: string, fallbackTitle?: string | null, fallbackUrl?: string | null) => {
        let entry = byPr.get(prKey);
        if (entry == null) {
          const known = titles.get(prKey);
          entry = { prKey, title: known?.title ?? fallbackTitle ?? prKey.replace(/^github\.com\//, ""), url: known?.url ?? fallbackUrl ?? prUrl(prKey), ms: 0, reviews: [], comments: 0, actions: [], lastAt: at };
          byPr.set(prKey, entry);
        }
        if (at > entry.lastAt) entry.lastAt = at;
        return entry;
      };
      const totals: ActivitySummary["totals"] = { activeMs: 0, reviewMs: 0, homeMs: 0, estimatedMs: 0, reviews: { APPROVE: 0, REQUEST_CHANGES: 0, COMMENT: 0, ARCHIVED: 0 }, reviewsVia: { piReview: 0, githubOnly: 0 }, reviewComments: 0, preReview: { accept: 0, draft: 0, close: 0 }, triage: 0, sendBack: 0, prsTouched: 0, avgMsPerReviewedPr: null };

      for (const event of ledger) {
        if (!inRange(event.at)) continue;
        if (event.kind === "time") {
          totals.activeMs += event.ms;
          if (event.surface === "review") totals.reviewMs += event.ms;
          else totals.homeMs += event.ms;
          day(event.at).activeMs += event.ms;
          if (event.prKey != null) pr(event.prKey, event.at).ms += event.ms;
          continue;
        }
        pr(event.prKey, event.at, event.title, event.url).actions.push(event.action);
        if (event.action.startsWith("pre-review:")) {
          totals.preReview[event.action.slice("pre-review:".length) as "accept" | "draft" | "close"] += 1;
          day(event.at).preReviews += 1;
        } else if (event.action.startsWith("triage:")) {
          totals.triage += 1;
          day(event.at).triage += 1;
        } else if (event.action === "send-back") totals.sendBack += 1;
      }

      // Merge Pi Review submissions and GitHub contributions into PR-days with the strongest verdict.
      type ReviewDay = { prKey: string; at: string; verdict: ReviewVerdict; viaPiReview: boolean; comments: number };
      const reviewDays = new Map<string, ReviewDay>();
      const addReview = (prKey: string, at: string, verdict: ReviewVerdict, viaPiReview: boolean, comments: number) => {
        const key = `${prKey}@${dayOf(at)}`;
        const existing = reviewDays.get(key);
        if (existing == null) {
          reviewDays.set(key, { prKey, at, verdict, viaPiReview, comments });
          return;
        }
        if (VERDICT_RANK[verdict] > VERDICT_RANK[existing.verdict]) existing.verdict = verdict;
        existing.viaPiReview ||= viaPiReview;
        existing.comments += comments;
        if (at > existing.at) existing.at = at;
      };
      for (const record of memory) {
        if (!inRange(record.createdAt)) continue;
        if (record.disposition === "archived") {
          totals.reviews.ARCHIVED += 1;
          totals.reviewComments += record.comments.length;
          const entry = pr(record.prKey, record.createdAt);
          entry.reviews.push("ARCHIVED");
          entry.comments += record.comments.length;
          continue;
        }
        addReview(record.prKey, record.createdAt, record.event, true, record.comments.length);
      }
      for (const review of githubStore?.reviews ?? []) {
        if (inRange(review.at)) addReview(review.prKey, review.at, githubVerdict(review.state), false, 0);
      }
      for (const review of reviewDays.values()) {
        totals.reviews[review.verdict] += 1;
        totals.reviewComments += review.comments;
        if (review.viaPiReview) totals.reviewsVia.piReview += 1;
        else totals.reviewsVia.githubOnly += 1;
        day(review.at).reviews += 1;
        const entry = pr(review.prKey, review.at);
        entry.reviews.push(review.verdict);
        entry.comments += review.comments;
      }

      for (const session of usageEstimate.sessions) {
        if (!inRange(session.at)) continue;
        totals.estimatedMs += session.ms;
        day(session.at).estimatedMs += session.ms;
      }

      // Empty days stay on the chart so gaps read as gaps; step at noon so DST shifts cannot skip or repeat a day.
      const firstDay = from ?? [...days.keys()].sort()[0];
      if (firstDay != null) {
        const start = Date.parse(from ?? `${firstDay}T00:00:00`) + 12 * 3_600_000;
        for (let at = start, count = 0; at <= Date.parse(now) + 12 * 3_600_000 && count < 800; at += 86_400_000, count += 1) day(new Date(at).toISOString());
      }
      const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
      const prList = [...byPr.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      totals.prsTouched = prList.length;
      const reviewed = prList.filter((entry) => entry.ms > 0 && entry.reviews.some((kind) => kind !== "ARCHIVED"));
      totals.avgMsPerReviewedPr = reviewed.length === 0 ? null : Math.round(reviewed.reduce((sum, entry) => sum + entry.ms, 0) / reviewed.length);
      return { range, from, generatedAt: now, trackingSince, totals, days: dayList, weeks: weeksFromDays(dayList), prs: prList, github: { syncedAt: githubStore?.syncedAt ?? null, coveredFrom: githubStore?.coveredFrom ?? null, enabled: deps.fetchGithubReviews != null } };
  }

  async function runSync(force: boolean): Promise<{ added: number; total: number; syncedAt: string | null; skipped: boolean }> {
    const stored = await deps.readGithubReviews().catch(() => null);
    const now = deps.now();
    if (deps.fetchGithubReviews == null || (!force && stored != null && Date.parse(now) - Date.parse(stored.syncedAt) < SYNC_INTERVAL_MS)) {
      return { added: 0, total: stored?.reviews.length ?? 0, syncedAt: stored?.syncedAt ?? null, skipped: true };
    }
    const fromMs = stored == null ? Date.parse(now) - BACKFILL_MS : Math.max(Date.parse(now) - BACKFILL_MS, Date.parse(stored.syncedAt) - SYNC_OVERLAP_MS);
    const fetched = await deps.fetchGithubReviews(new Date(fromMs).toISOString(), now);
    const byId = new Map((stored?.reviews ?? []).map((review) => [review.id, review] as const));
    let added = 0;
    for (const review of fetched) {
      if (!byId.has(review.id)) added += 1;
      byId.set(review.id, review);
    }
    const next: GithubReviewStore = { version: 1, syncedAt: now, coveredFrom: stored?.coveredFrom ?? new Date(fromMs).toISOString(), reviews: [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)) };
    await deps.writeGithubReviews(next);
    if (deps.writeReport != null) await deps.writeReport(renderActivityReport(await buildSummary("year")));
    return { added, total: next.reviews.length, syncedAt: now, skipped: false };
  }

  return {
    async heartbeat(payload) {
      const surface = payload.surface;
      if (surface !== "review" && surface !== "home") throw new Error("Expected surface to be review or home");
      const ms = payload.ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) throw new Error("Expected positive ms");
      const prKey = typeof payload.prKey === "string" && payload.prKey.length > 0 ? payload.prKey : null;
      if (prKey != null && !PR_KEY.test(prKey)) throw new Error("Expected prKey like github.com/owner/repo#123");
      await append({ kind: "time", at: deps.now(), ms: Math.min(Math.round(ms), MAX_HEARTBEAT_MS), surface, prKey: surface === "review" ? prKey : null });
      return { recorded: 1 };
    },

    async recordAction({ action, prKey, title, url }) {
      await append({ kind: "action", at: deps.now(), action, prKey, title: title ?? null, url: url ?? null });
    },

    summary: buildSummary,

    sync(options) {
      syncing ??= runSync(options?.force === true).finally(() => { syncing = null; });
      return syncing;
    },
  };
}
