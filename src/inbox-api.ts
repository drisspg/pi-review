import type { GitHubNotification, InboxItem, InboxLatestActivity, InboxResponse, InboxSubjectKind, InboxSubjectSnapshot, InboxTier, StoredPullRequest, ViewerPullRequest, ViewerPullRequestScope } from "./types.js";

export type InboxSubjectRef = { repo: string; number: number; kind: InboxSubjectKind };

/**
 * Everything the inbox needs to render, persisted between refreshes and across
 * server restarts. A refresh always re-lists notifications (two cheap calls) but
 * re-fetches PR/issue state and latest activity only for threads whose
 * `updatedAt` moved, so steady-state refreshes cost seconds, not the world.
 */
export type InboxSnapshot = {
  version: 2;
  login: string | null;
  /** Last time any refresh cycle completed. */
  fetchedAt: string;
  /** Last time the notification list itself was re-read from GitHub (rate-limited to once per staleMs). */
  notificationsAt: string;
  notifications: GitHubNotification[];
  subjects: Record<string, { at: string; snapshot: InboxSubjectSnapshot }>;
  latest: Record<string, { updatedAt: string; latest: InboxLatestActivity }>;
  viewerPrs: { openAt: string | null; closedAt: string | null; open: ViewerPullRequest[]; closed: ViewerPullRequest[] };
  /** Enrichment still owed after the last cycle; the next cycle picks it up. */
  backlog: number;
  warnings: string[];
};

/**
 * Per-cycle GitHub budget. GitHub's secondary rate limit is per account and
 * shared with the browser, so one inbox refresh must never burst: a cycle
 * re-lists notifications at most once a minute, fetches one GraphQL batch of
 * PR/issue state, a handful of latest comments, and at most one viewer-PR
 * search. Whatever is left over is a backlog the next cycle continues.
 */
export const REFRESH_BUDGET = { subjects: 40, latest: 6, viewerPrScopes: 1 } as const;
export type RefreshResult = { snapshot: InboxSnapshot; rateLimited: boolean };

export type InboxApiDeps = {
  fetchNotifications: () => Promise<GitHubNotification[]>;
  fetchSubjectSnapshots: (refs: InboxSubjectRef[]) => Promise<InboxSubjectSnapshot[]>;
  fetchViewerLogin: () => Promise<string | null>;
  fetchViewerPullRequests: (login: string, scope: ViewerPullRequestScope) => Promise<ViewerPullRequest[]>;
  /** Latest activity per comment URL; only called for the tiers where "who pinged me" changes the answer. */
  fetchLatestActivity: (urls: string[], login: string | null) => Promise<Map<string, InboxLatestActivity>>;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  markNotificationDone: (threadId: string) => Promise<void>;
  unsubscribeNotification: (threadId: string) => Promise<void>;
  readSnapshot: () => Promise<InboxSnapshot | null>;
  writeSnapshot: (snapshot: InboxSnapshot) => Promise<void>;
  now: () => string;
  /** Injectable timer so tests can drive background refreshes; defaults to setTimeout. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  logger?: { info: (scope: string, message: string, data?: Record<string, unknown>) => void; warn: (scope: string, message: string, data?: Record<string, unknown>) => void };
  /** A snapshot older than this is served immediately and refreshed in the background. */
  staleMs?: number;
  /** Keep refreshing in the background this long after the last request, so reloads stay warm. */
  activeWindowMs?: number;
  /** Delay between continuation cycles while enrichment backlog remains. */
  backlogDelayMs?: number;
  /** How long to stop talking to GitHub after it reports a (secondary) rate limit. */
  rateLimitPauseMs?: number;
};

export type InboxApi = {
  inbox: (options?: { refresh?: boolean }) => Promise<InboxResponse>;
  done: (payload: Record<string, unknown>) => Promise<{ done: string[] }>;
  mute: (payload: Record<string, unknown>) => Promise<{ muted: string[] }>;
  /** Waits for any in-flight refresh; tests and shutdown use it, routes never do. */
  settle: () => Promise<void>;
};

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DEFAULT_STALE_MS = 60 * 1000;
const DEFAULT_ACTIVE_WINDOW_MS = 15 * MINUTE_MS;
const DEFAULT_BACKLOG_DELAY_MS = 10 * 1000;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 10 * MINUTE_MS;
const CLOSED_PRS_TTL_MS = 30 * MINUTE_MS;
/** PR/issue state can change without a notification (e.g. a merge you are not subscribed to), so re-check periodically. */
const SUBJECT_TTL_MS = 15 * MINUTE_MS;
const VIEWER_PRS_TTL_MS = 5 * MINUTE_MS;
const LATEST_ACTIVITY_LIMIT = 60;
const ENRICHED_TIERS = new Set<InboxTier>(["needs-you", "your-prs"]);
const TIERS: InboxTier[] = ["needs-you", "review-requests", "your-prs", "fyi", "resolved"];

export function subjectKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** Matches StoredPullRequest.key for github.com so inbox rows can open straight into a saved review. */
function localPrKey(repo: string, number: number): string {
  return `github.com/${repo}#${number}`;
}

function subjectUrl(notification: GitHubNotification, snapshot: InboxSubjectSnapshot | undefined): string {
  if (snapshot != null) return snapshot.url;
  const base = `https://github.com/${notification.repo}`;
  if (notification.subjectNumber == null) return `${base}/notifications`;
  return notification.subjectKind === "pr" ? `${base}/pull/${notification.subjectNumber}` : `${base}/issues/${notification.subjectNumber}`;
}

function recencyBonus(updatedAt: string, nowMs: number): number {
  const ageHours = (nowMs - Date.parse(updatedAt)) / HOUR_MS;
  if (!Number.isFinite(ageHours) || ageHours < 6) return 20;
  if (ageHours < 24) return 15;
  if (ageHours < 72) return 10;
  if (ageHours < 24 * 7) return 5;
  return 0;
}

function baseRank(reason: string): { tier: InboxTier; score: number; why: string } {
  switch (reason) {
    case "mention":
      return { tier: "needs-you", score: 100, why: "You were mentioned" };
    case "team_mention":
      return { tier: "needs-you", score: 95, why: "Your team was mentioned" };
    case "security_alert":
      return { tier: "needs-you", score: 95, why: "Security alert" };
    case "assign":
      return { tier: "needs-you", score: 90, why: "Assigned to you" };
    case "approval_requested":
      return { tier: "needs-you", score: 85, why: "Your approval was requested" };
    case "review_requested":
      return { tier: "review-requests", score: 80, why: "Review requested" };
    case "author":
      return { tier: "your-prs", score: 70, why: "Activity on your PR" };
    case "state_change":
      return { tier: "fyi", score: 40, why: "State changed" };
    case "comment":
      return { tier: "fyi", score: 40, why: "New comment" };
    case "ci_activity":
      return { tier: "fyi", score: 35, why: "CI activity" };
    case "manual":
      return { tier: "fyi", score: 30, why: "You subscribed" };
    default:
      return { tier: "fyi", score: 25, why: "Subscribed" };
  }
}

/**
 * Pure triage: turn raw notifications plus their subject snapshots into scored,
 * tiered inbox rows. Closed/merged subjects sink to "resolved" unless someone
 * mentioned or assigned the viewer within the last two days, since that reply
 * may still be owed even though the thread is closed.
 */
export function rankInbox(notifications: GitHubNotification[], snapshots: InboxSubjectSnapshot[], localPrs: StoredPullRequest[], nowIso: string): { items: InboxItem[]; tiers: Record<InboxTier, number> } {
  const nowMs = Date.parse(nowIso);
  const snapshotByKey = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot] as const));
  const localKeys = new Set(localPrs.map((pr) => pr.key));
  const items: InboxItem[] = [];
  for (const notification of notifications) {
    const snapshot = notification.subjectNumber == null ? undefined : snapshotByKey.get(subjectKey(notification.repo, notification.subjectNumber));
    const base = baseRank(notification.reason);
    let tier = base.tier;
    let score = base.score + recencyBonus(notification.updatedAt, nowMs);
    const why = [base.why];
    const ageHours = (nowMs - Date.parse(notification.updatedAt)) / HOUR_MS;
    const closed = snapshot?.state === "CLOSED" || snapshot?.state === "MERGED";
    if (closed) {
      const stillOwed = tier === "needs-you" && ageHours < 48;
      why.push(snapshot?.state === "MERGED" ? "Merged" : "Closed");
      if (!stillOwed) tier = "resolved";
      score -= 50;
    } else if (tier === "review-requests" && snapshot?.isDraft) {
      tier = "fyi";
      score -= 40;
      why.push("Still a draft");
    } else if (tier === "review-requests") {
      if (snapshot?.checks === "FAILURE" || snapshot?.checks === "ERROR") {
        score -= 10;
        why.push("CI failing");
      }
      if (snapshot?.reviewDecision === "APPROVED") {
        score -= 15;
        why.push("Already approved");
      } else if (snapshot?.reviewDecision === "CHANGES_REQUESTED") {
        score -= 10;
        why.push("Changes already requested");
      }
    } else if (tier === "your-prs") {
      if (snapshot?.checks === "FAILURE" || snapshot?.checks === "ERROR") {
        score += 10;
        why.push("CI failing");
      }
      if (snapshot?.reviewDecision === "CHANGES_REQUESTED") {
        score += 10;
        why.push("Changes requested");
      } else if (snapshot?.reviewDecision === "APPROVED") {
        score += 5;
        why.push("Approved");
      }
    }
    const number = notification.subjectNumber;
    const key = number == null ? null : localPrKey(notification.repo, number);
    items.push({
      id: notification.id,
      tier,
      score,
      reason: notification.reason,
      title: notification.subjectTitle,
      repo: notification.repo,
      number,
      kind: notification.subjectKind,
      url: subjectUrl(notification, snapshot),
      updatedAt: notification.updatedAt,
      state: snapshot?.state ?? null,
      isDraft: snapshot?.isDraft ?? false,
      author: snapshot?.author ?? null,
      reviewDecision: snapshot?.reviewDecision ?? null,
      checks: snapshot?.checks ?? null,
      localPrKey: key != null && localKeys.has(key) ? key : null,
      latest: null,
      why,
    });
  }
  sortItems(items);
  return { items, tiers: tierCounts(items) };
}

function sortItems(items: InboxItem[]): void {
  items.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Bot chatter (merge bots, CI, auto-cc) is the main reason a "mention" is not
 * actually pressing, so once the latest actor is known, bots sink below every
 * human ping while a comment that names the viewer directly floats up.
 */
export function applyLatestActivity(items: InboxItem[], latestByThread: Map<string, InboxLatestActivity>): InboxItem[] {
  const next = items.map((item) => {
    const latest = latestByThread.get(item.id);
    if (latest == null) return item;
    let score = item.score;
    const why = [...item.why];
    if (latest.bot) {
      score -= 25;
      why.push(`Latest activity is ${latest.author ?? "a bot"}`);
    } else if (latest.pingsViewer) {
      score += 5;
      why.push(`${latest.author ?? "Someone"} pinged you`);
    }
    return { ...item, latest, score, why };
  });
  sortItems(next);
  return next;
}

function tierCounts(items: InboxItem[]): Record<InboxTier, number> {
  const counts = Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<InboxTier, number>;
  for (const item of items) counts[item.tier] += 1;
  return counts;
}

function threadIds(payload: Record<string, unknown>): string[] {
  const raw = payload.threadIds ?? (payload.threadId == null ? [] : [payload.threadId]);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("threadIds is required");
  return raw.map((id) => {
    if (typeof id !== "string" || id.trim().length === 0) throw new Error("threadIds must be non-empty strings");
    return id.trim();
  });
}

function ageMs(iso: string | null | undefined, nowIso: string): number {
  if (iso == null) return Number.POSITIVE_INFINITY;
  return Date.parse(nowIso) - Date.parse(iso);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** gh error messages embed the whole command; keep only the trailing "gh: HTTP 504"-style reason. */
function shortError(error: unknown): string {
  const text = errorText(error);
  const match = /gh: (.+)$/m.exec(text);
  return (match?.[1] ?? text).trim().slice(0, 160);
}

export function isRateLimitError(error: unknown): boolean {
  const text = errorText(error);
  return /secondary rate limit|abuse detection|rate limit exceeded|API rate limit|HTTP 429/i.test(text);
}

function emptySnapshot(now: string): InboxSnapshot {
  return { version: 2, login: null, fetchedAt: now, notificationsAt: now, notifications: [], subjects: {}, latest: {}, viewerPrs: { openAt: null, closedAt: null, open: [], closed: [] }, backlog: 0, warnings: [] };
}

/** Render the served response from a snapshot; ranking is pure and cheap, so it runs per request with the current clock. */
export function buildInboxResponse(snapshot: InboxSnapshot, localPrs: StoredPullRequest[], nowIso: string, refreshing: boolean): InboxResponse {
  const localKeys = new Set(localPrs.map((pr) => pr.key));
  const ranked = rankInbox(snapshot.notifications, Object.values(snapshot.subjects).map((entry) => entry.snapshot), localPrs, nowIso);
  const latestByThread = new Map(Object.entries(snapshot.latest).map(([id, entry]) => [id, entry.latest] as const));
  const items = applyLatestActivity(ranked.items, latestByThread);
  const withLocalKey = (pr: ViewerPullRequest): ViewerPullRequest => ({ ...pr, localPrKey: localKeys.has(localPrKey(pr.repo, pr.number)) ? localPrKey(pr.repo, pr.number) : null });
  return {
    login: snapshot.login,
    fetchedAt: snapshot.fetchedAt,
    refreshing,
    backlog: snapshot.backlog,
    pausedUntil: null,
    items,
    tiers: tierCounts(items),
    myPrs: snapshot.viewerPrs.open.map(withLocalKey),
    recentlyClosedPrs: snapshot.viewerPrs.closed.map(withLocalKey),
    warnings: snapshot.warnings,
  };
}

/**
 * One budgeted refresh cycle. The notification list is re-read only when it is
 * older than `listStaleMs` (so continuation cycles cost nothing there); then
 * the cycle spends REFRESH_BUDGET on the most valuable missing enrichment:
 * changed/new subjects first, then the highest-ranked threads without a
 * latest-activity row, then whichever viewer-PR scope is most overdue.
 */
export async function refreshSnapshot(deps: InboxApiDeps, previous: InboxSnapshot | null, options: { force?: boolean; listStaleMs?: number } = {}): Promise<RefreshResult> {
  const now = deps.now();
  const warnings: string[] = [];
  let rateLimited = false;
  const fail = (label: string, error: unknown): null => {
    if (isRateLimitError(error)) rateLimited = true;
    warnings.push(previous != null ? `Could not refresh ${label} (${shortError(error)}); showing what was loaded before.` : `Could not load ${label}: ${shortError(error)}`);
    return null;
  };

  const relist = options.force || previous == null || ageMs(previous.notificationsAt, now) > (options.listStaleMs ?? DEFAULT_STALE_MS);
  const [listed, login] = await Promise.all([
    relist ? deps.fetchNotifications().catch((error: unknown) => fail("notifications", error)) : Promise.resolve(null),
    deps.fetchViewerLogin(),
  ]);
  const notifications = listed ?? previous?.notifications ?? [];
  const notificationsAt = listed != null ? now : previous?.notificationsAt ?? now;
  const byId = new Map(notifications.map((notification) => [notification.id, notification] as const));
  const previousById = new Map((previous?.notifications ?? []).map((notification) => [notification.id, notification] as const));

  // Subjects: carry over what we know, then queue missing/changed/expired, most recently active first.
  const subjects: InboxSnapshot["subjects"] = {};
  const queue: Array<{ ref: InboxSubjectRef; updatedAt: string }> = [];
  const queued = new Set<string>();
  for (const notification of notifications) {
    if (notification.subjectNumber == null || notification.subjectKind === "other") continue;
    const key = subjectKey(notification.repo, notification.subjectNumber);
    const known = previous?.subjects[key];
    if (known != null) subjects[key] = known;
    const changed = previousById.get(notification.id)?.updatedAt !== notification.updatedAt;
    const expired = known != null && ageMs(known.at, now) > SUBJECT_TTL_MS;
    if ((known == null || changed || expired) && !queued.has(key)) {
      queued.add(key);
      queue.push({ ref: { repo: notification.repo, number: notification.subjectNumber, kind: notification.subjectKind }, updatedAt: notification.updatedAt });
    }
  }
  queue.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const subjectBatch = queue.slice(0, REFRESH_BUDGET.subjects).map((entry) => entry.ref);
  if (subjectBatch.length > 0) {
    const fetched = await deps.fetchSubjectSnapshots(subjectBatch).catch((error: unknown) => fail("PR/issue state", error));
    for (const snapshot of fetched ?? []) subjects[snapshot.key] = { at: now, snapshot };
  }
  let backlog = Math.max(0, queue.length - subjectBatch.length);

  // Latest activity: keyed by (thread, updatedAt); fill the top-ranked gaps first.
  const latest: InboxSnapshot["latest"] = {};
  const ranked = rankInbox(notifications, Object.values(subjects).map((entry) => entry.snapshot), [], now);
  const latestQueue: Array<[string, string]> = [];
  for (const item of ranked.items) {
    const notification = byId.get(item.id);
    if (!ENRICHED_TIERS.has(item.tier) || notification?.latestCommentUrl == null) continue;
    const known = previous?.latest[item.id];
    if (known != null && known.updatedAt === notification.updatedAt) latest[item.id] = known;
    else latestQueue.push([item.id, notification.latestCommentUrl]);
  }
  const latestBatch = latestQueue.slice(0, REFRESH_BUDGET.latest);
  if (latestBatch.length > 0) {
    const fetched = await deps.fetchLatestActivity(latestBatch.map(([, url]) => url), login).catch((error: unknown) => fail("latest activity", error));
    for (const [id, url] of latestBatch) {
      const row = fetched?.get(url);
      if (row != null) latest[id] = { updatedAt: byId.get(id)?.updatedAt ?? now, latest: row };
    }
  }
  backlog += Math.max(0, latestQueue.length - latestBatch.length);

  // Viewer PRs: one search per cycle, whichever scope is most overdue.
  const viewerPrs = { ...(previous?.viewerPrs ?? emptySnapshot(now).viewerPrs) };
  if (previous != null && previous.login !== login) Object.assign(viewerPrs, { openAt: null, closedAt: null, open: [], closed: [] });
  const openDue = login != null && (viewerPrs.openAt == null || ageMs(viewerPrs.openAt, now) > VIEWER_PRS_TTL_MS);
  const closedDue = login != null && (viewerPrs.closedAt == null || ageMs(viewerPrs.closedAt, now) > CLOSED_PRS_TTL_MS);
  const scope: ViewerPullRequestScope | null = openDue ? "open" : closedDue ? "recently-closed" : null;
  if (scope != null && login != null) {
    const fetched = await deps.fetchViewerPullRequests(login, scope).catch((error: unknown) => fail(scope === "open" ? "your open PRs" : "your recently closed PRs", error));
    if (fetched != null) {
      if (scope === "open") Object.assign(viewerPrs, { open: fetched, openAt: now });
      else Object.assign(viewerPrs, { closed: fetched, closedAt: now });
    }
  }
  if (scope === "open" && closedDue) backlog += 1;

  deps.logger?.info("inbox", "refresh cycle", { relisted: listed != null, notifications: notifications.length, subjectsFetched: subjectBatch.length, latestFetched: latestBatch.length, viewerScope: scope, backlog, warnings: warnings.length, rateLimited });
  return { rateLimited, snapshot: { version: 2, login, fetchedAt: now, notificationsAt, notifications, subjects, latest, viewerPrs, backlog, warnings } };
}

export function createInboxApi(deps: InboxApiDeps): InboxApi {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const activeWindowMs = deps.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const backlogDelayMs = deps.backlogDelayMs ?? DEFAULT_BACKLOG_DELAY_MS;
  const rateLimitPauseMs = deps.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
  const setTimer = deps.setTimer ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  });
  let snapshot: InboxSnapshot | null = null;
  let loadedFromDisk: Promise<void> | null = null;
  let inFlight: Promise<void> | null = null;
  let cancelTimer: (() => void) | null = null;
  let lastRequestAt: number | null = null;
  let lastError: string | null = null;
  let pausedUntil: number | null = null;

  function nowMs(): number {
    return Date.parse(deps.now());
  }

  function loadFromDisk(): Promise<void> {
    loadedFromDisk ??= deps.readSnapshot().then((stored) => {
      if (stored?.version === 2 && snapshot == null) snapshot = stored;
    }).catch((error: unknown) => {
      deps.logger?.warn("inbox", "could not read persisted inbox", { error: errorText(error) });
    });
    return loadedFromDisk;
  }

  async function persist(next: InboxSnapshot): Promise<void> {
    snapshot = next;
    try {
      await deps.writeSnapshot(next);
    } catch (error) {
      deps.logger?.warn("inbox", "could not persist inbox", { error: errorText(error) });
    }
  }

  function paused(): boolean {
    if (pausedUntil == null) return false;
    if (nowMs() < pausedUntil) return true;
    pausedUntil = null;
    return false;
  }

  // Keep the snapshot warm while someone is looking: continue quickly while there is backlog,
  // otherwise wait for the stale boundary, and stop once the page has gone quiet.
  function scheduleBackgroundRefresh(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (lastRequestAt == null || nowMs() - lastRequestAt > activeWindowMs) return;
    const delay = pausedUntil != null ? Math.max(pausedUntil - nowMs(), backlogDelayMs) : (snapshot?.backlog ?? 0) > 0 ? backlogDelayMs : staleMs;
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      void startRefresh({});
    }, delay);
  }

  function startRefresh(options: { force?: boolean }): Promise<void> {
    if (inFlight != null) return inFlight;
    if (paused()) {
      scheduleBackgroundRefresh();
      return Promise.resolve();
    }
    inFlight = refreshSnapshot(deps, snapshot, { force: options.force, listStaleMs: staleMs }).then(async (result) => {
      lastError = null;
      if (result.rateLimited) {
        pausedUntil = nowMs() + rateLimitPauseMs;
        deps.logger?.warn("inbox", "GitHub rate limit reported; pausing inbox refreshes", { pauseMs: rateLimitPauseMs });
      }
      await persist(result.snapshot);
    }).catch((error: unknown) => {
      lastError = errorText(error);
      if (isRateLimitError(error)) pausedUntil = nowMs() + rateLimitPauseMs;
      deps.logger?.warn("inbox", "refresh failed", { error: lastError });
    }).finally(() => {
      inFlight = null;
      scheduleBackgroundRefresh();
    });
    return inFlight;
  }

  async function dropThreads(ids: string[]): Promise<void> {
    await loadFromDisk();
    if (snapshot == null) return;
    const gone = new Set(ids);
    const latest = { ...snapshot.latest };
    for (const id of ids) delete latest[id];
    await persist({ ...snapshot, notifications: snapshot.notifications.filter((notification) => !gone.has(notification.id)), latest });
  }

  return {
    async inbox(options) {
      const now = deps.now();
      lastRequestAt = Date.parse(now);
      await loadFromDisk();
      const stale = snapshot == null || options?.refresh === true || (snapshot.backlog > 0 && inFlight == null) || ageMs(snapshot.fetchedAt, now) > staleMs;
      if (stale) void startRefresh({ force: options?.refresh === true });
      else if (cancelTimer == null && inFlight == null) scheduleBackgroundRefresh();
      const localPrs = await deps.listRecentPullRequests();
      const response = buildInboxResponse(snapshot ?? emptySnapshot(now), localPrs, now, inFlight != null);
      if (snapshot == null) response.fetchedAt = null;
      if (paused() && pausedUntil != null) {
        response.pausedUntil = new Date(pausedUntil).toISOString();
        response.warnings = [...response.warnings, `GitHub reported a rate limit; inbox refreshes are paused until ${new Date(pausedUntil).toLocaleTimeString()}.`];
      }
      if (lastError != null) response.warnings = [...response.warnings, `Last refresh failed: ${lastError}`];
      return response;
    },
    async done(payload) {
      const ids = threadIds(payload);
      await Promise.all(ids.map((id) => deps.markNotificationDone(id)));
      await dropThreads(ids);
      return { done: ids };
    },
    async mute(payload) {
      const ids = threadIds(payload);
      await Promise.all(ids.map(async (id) => {
        await deps.unsubscribeNotification(id);
        await deps.markNotificationDone(id);
      }));
      await dropThreads(ids);
      return { muted: ids };
    },
    async settle() {
      await loadFromDisk();
      while (inFlight != null) await inFlight;
    },
  };
}
