import type { ReviewMemoryRecord, StoredPullRequest } from "./types.js";

/**
 * Review activity ledger: how much focused time goes into reviewing and what came out of it.
 *
 * Measured data is an append-only JSONL ledger of (a) client heartbeats that only count time
 * while the tab is visible, focused, and recently interacted with, and (b) workflow actions the
 * server performed (pre-review decisions, triage labels, send-backs). Submitted reviews are
 * read from reviewMemory, which predates this ledger. Days before the ledger existed get an
 * explicitly labeled time estimate from bursts of interactive events in the usage log.
 */
export type ActivitySurface = "review" | "home";
export type ActivityAction = "pre-review:accept" | "pre-review:draft" | "pre-review:close" | "send-back" | `triage:${string}`;
export type ActivityRange = "today" | "7d" | "30d" | "all";

type TimeEvent = { kind: "time"; at: string; ms: number; surface: ActivitySurface; prKey: string | null };
type ActionEvent = { kind: "action"; at: string; action: ActivityAction; prKey: string; title: string | null; url: string | null };
type LedgerEvent = TimeEvent | ActionEvent;

export type ActivityDay = { date: string; activeMs: number; estimatedMs: number; reviews: number; preReviews: number; triage: number };
export type ActivityPr = { prKey: string; title: string; url: string | null; ms: number; reviews: Array<ReviewMemoryRecord["event"] | "ARCHIVED">; comments: number; actions: ActivityAction[]; lastAt: string };
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
    reviewComments: number;
    preReview: { accept: number; draft: number; close: number };
    triage: number;
    sendBack: number;
    prsTouched: number;
    /** Mean measured time on PRs that received a submitted review in range; null until there is data. */
    avgMsPerReviewedPr: number | null;
  };
  days: ActivityDay[];
  prs: ActivityPr[];
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
};

export type ActivityApi = {
  heartbeat: (payload: Record<string, unknown>) => Promise<{ recorded: number }>;
  recordAction: (input: { action: ActivityAction; prKey: string; title?: string | null; url?: string | null }) => Promise<void>;
  summary: (range: string | null) => Promise<ActivitySummary>;
};

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
  return range === "today" || range === "7d" || range === "30d" || range === "all" ? range : "7d";
}

function prUrl(prKey: string): string | null {
  const match = /^github\.com\/([^#]+)#(\d+)$/.exec(prKey);
  return match == null ? null : `https://github.com/${match[1]}/pull/${match[2]}`;
}

export function createActivityApi(deps: ActivityApiDeps): ActivityApi {
  const dayOf = deps.dayOf ?? localDay;
  const startOfDay = deps.startOfDay ?? localStartOfDay;
  let writes = Promise.resolve();
  let usageEstimate: { before: string | null; sessions: Array<{ at: string; ms: number }> } | null = null;

  function append(event: LedgerEvent): Promise<void> {
    writes = writes.then(() => deps.appendLedger(`${JSON.stringify(event)}\n`));
    return writes;
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

    async summary(rawRange) {
      const range = parseRange(rawRange);
      const now = deps.now();
      const from = range === "all" ? null : startOfDay(now, range === "today" ? 0 : range === "7d" ? 6 : 29);
      const inRange = (at: string) => from == null || at >= from;
      await writes;
      const [ledgerText, memory, prs] = await Promise.all([deps.readLedger().catch(() => ""), deps.listReviewMemoryRecords(), deps.listRecentPullRequests()]);
      const ledger = parseLines(ledgerText, isLedgerEvent);
      const trackingSince = ledger.find((event) => event.kind === "time")?.at ?? null;
      // The usage log only grows and the estimate only covers time before measurement began, so it is computed once.
      if (usageEstimate == null || usageEstimate.before !== trackingSince) usageEstimate = { before: trackingSince, sessions: estimateUsageSessions(await deps.readUsageLog().catch(() => ""), trackingSince) };

      const titles = new Map(prs.map((pr) => [pr.key, { title: pr.title, url: pr.url }] as const));
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
      const totals: ActivitySummary["totals"] = { activeMs: 0, reviewMs: 0, homeMs: 0, estimatedMs: 0, reviews: { APPROVE: 0, REQUEST_CHANGES: 0, COMMENT: 0, ARCHIVED: 0 }, reviewComments: 0, preReview: { accept: 0, draft: 0, close: 0 }, triage: 0, sendBack: 0, prsTouched: 0, avgMsPerReviewedPr: null };

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

      for (const record of memory) {
        if (!inRange(record.createdAt)) continue;
        const kind = record.disposition === "archived" ? "ARCHIVED" : record.event;
        totals.reviews[kind] += 1;
        totals.reviewComments += record.comments.length;
        day(record.createdAt).reviews += 1;
        const entry = pr(record.prKey, record.createdAt);
        entry.reviews.push(kind);
        entry.comments += record.comments.length;
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
        for (let at = start, count = 0; at <= Date.parse(now) + 12 * 3_600_000 && count < 400; at += 86_400_000, count += 1) day(new Date(at).toISOString());
      }
      const prList = [...byPr.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      totals.prsTouched = prList.length;
      const reviewed = prList.filter((entry) => entry.ms > 0 && entry.reviews.some((kind) => kind !== "ARCHIVED"));
      totals.avgMsPerReviewedPr = reviewed.length === 0 ? null : Math.round(reviewed.reduce((sum, entry) => sum + entry.ms, 0) / reviewed.length);
      return { range, from, generatedAt: now, trackingSince, totals, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), prs: prList };
    },
  };
}
