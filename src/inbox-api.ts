import type { GitHubNotification, InboxItem, InboxLatestActivity, InboxResponse, InboxSubjectKind, InboxSubjectSnapshot, InboxTier, StoredPullRequest, ViewerPullRequest, ViewerPullRequestScope } from "./types.js";

export type InboxSubjectRef = { repo: string; number: number; kind: InboxSubjectKind };

/**
 * Everything the inbox needs to render, persisted between refreshes and across
 * server restarts. A refresh always re-lists notifications (two cheap calls) but
 * re-fetches PR/issue state and latest activity only for threads whose
 * `updatedAt` moved, so steady-state refreshes cost seconds, not the world.
 */
export type InboxSnapshot = {
  version: 1;
  login: string | null;
  fetchedAt: string;
  notifications: GitHubNotification[];
  subjects: Record<string, { at: string; snapshot: InboxSubjectSnapshot }>;
  latest: Record<string, { updatedAt: string; latest: InboxLatestActivity }>;
  viewerPrs: { at: string; open: ViewerPullRequest[]; closed: ViewerPullRequest[] } | null;
  warnings: string[];
};

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

function emptySnapshot(now: string): InboxSnapshot {
  return { version: 1, login: null, fetchedAt: now, notifications: [], subjects: {}, latest: {}, viewerPrs: null, warnings: [] };
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
    items,
    tiers: tierCounts(items),
    myPrs: (snapshot.viewerPrs?.open ?? []).map(withLocalKey),
    recentlyClosedPrs: (snapshot.viewerPrs?.closed ?? []).map(withLocalKey),
    warnings: snapshot.warnings,
  };
}

/**
 * One incremental refresh: re-list notifications, then fetch only the subject
 * snapshots and latest-activity rows that are new, changed, or past their TTL.
 * Everything else is carried over from `previous`.
 */
export async function refreshSnapshot(deps: InboxApiDeps, previous: InboxSnapshot | null, options: { force?: boolean } = {}): Promise<InboxSnapshot> {
  const now = deps.now();
  const warnings: string[] = [];
  const [notifications, login] = await Promise.all([deps.fetchNotifications(), deps.fetchViewerLogin()]);
  const byId = new Map(notifications.map((notification) => [notification.id, notification] as const));
  const previousById = new Map((previous?.notifications ?? []).map((notification) => [notification.id, notification] as const));
  const changedIds = new Set(notifications.filter((notification) => previousById.get(notification.id)?.updatedAt !== notification.updatedAt).map((notification) => notification.id));

  const wantedKeys = new Set<string>();
  const refetch = new Map<string, InboxSubjectRef>();
  for (const notification of notifications) {
    if (notification.subjectNumber == null || notification.subjectKind === "other") continue;
    const key = subjectKey(notification.repo, notification.subjectNumber);
    wantedKeys.add(key);
    const known = previous?.subjects[key];
    if (options.force || known == null || changedIds.has(notification.id) || ageMs(known.at, now) > SUBJECT_TTL_MS) {
      refetch.set(key, { repo: notification.repo, number: notification.subjectNumber, kind: notification.subjectKind });
    }
  }

  const viewerPrsStale = options.force || previous?.viewerPrs == null || previous.login !== login || ageMs(previous.viewerPrs.at, now) > VIEWER_PRS_TTL_MS;
  const viewerPrs = (scope: ViewerPullRequestScope): Promise<ViewerPullRequest[] | null> => (login == null ? Promise.resolve([]) : deps.fetchViewerPullRequests(login, scope).catch((error: unknown) => {
    warnings.push(`Could not load your ${scope === "open" ? "open" : "recently closed"} PRs: ${errorText(error)}`);
    return null;
  }));
  const [freshSnapshots, openPrs, closedPrs] = await Promise.all([
    refetch.size === 0 ? Promise.resolve([]) : deps.fetchSubjectSnapshots([...refetch.values()]).catch((error: unknown) => {
      warnings.push(`Could not load PR/issue state: ${errorText(error)}`);
      return [] as InboxSubjectSnapshot[];
    }),
    viewerPrsStale ? viewerPrs("open") : Promise.resolve(null),
    viewerPrsStale ? viewerPrs("recently-closed") : Promise.resolve(null),
  ]);

  const subjects: InboxSnapshot["subjects"] = {};
  for (const key of wantedKeys) {
    const known = previous?.subjects[key];
    if (known != null) subjects[key] = known;
  }
  for (const snapshot of freshSnapshots) subjects[snapshot.key] = { at: now, snapshot };

  // Latest activity is keyed by (thread, updatedAt): unchanged threads keep their row for free.
  const latest: InboxSnapshot["latest"] = {};
  const ranked = rankInbox(notifications, Object.values(subjects).map((entry) => entry.snapshot), [], now);
  const urlByThread = new Map<string, string>();
  for (const item of ranked.items) {
    const notification = byId.get(item.id);
    if (!ENRICHED_TIERS.has(item.tier) || notification?.latestCommentUrl == null) continue;
    const known = previous?.latest[item.id];
    if (known != null && known.updatedAt === notification.updatedAt) latest[item.id] = known;
    else if (urlByThread.size < LATEST_ACTIVITY_LIMIT) urlByThread.set(item.id, notification.latestCommentUrl);
  }
  if (urlByThread.size > 0) {
    const fetched = await deps.fetchLatestActivity([...urlByThread.values()], login).catch((error: unknown) => {
      warnings.push(`Could not load latest activity: ${errorText(error)}`);
      return new Map<string, InboxLatestActivity>();
    });
    for (const [id, url] of urlByThread) {
      const row = fetched.get(url);
      if (row != null) latest[id] = { updatedAt: byId.get(id)?.updatedAt ?? now, latest: row };
    }
  }

  const previousViewerPrs = previous?.viewerPrs ?? null;
  const viewerPrsNext = !viewerPrsStale
    ? previousViewerPrs
    : { at: now, open: openPrs ?? previousViewerPrs?.open ?? [], closed: closedPrs ?? previousViewerPrs?.closed ?? [] };

  deps.logger?.info("inbox", "refresh complete", { notifications: notifications.length, changed: changedIds.size, subjectsFetched: refetch.size, latestFetched: urlByThread.size, viewerPrsRefetched: viewerPrsStale, warnings: warnings.length });
  return { version: 1, login, fetchedAt: now, notifications, subjects, latest, viewerPrs: viewerPrsNext, warnings };
}

export function createInboxApi(deps: InboxApiDeps): InboxApi {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const activeWindowMs = deps.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
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

  function loadFromDisk(): Promise<void> {
    loadedFromDisk ??= deps.readSnapshot().then((stored) => {
      if (stored?.version === 1 && snapshot == null) snapshot = stored;
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

  // Keep the snapshot warm while someone is looking: after each refresh, schedule the next one
  // at the stale boundary, but stop once the page has gone quiet for the active window.
  function scheduleBackgroundRefresh(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (lastRequestAt == null || Date.parse(deps.now()) - lastRequestAt > activeWindowMs) return;
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      void startRefresh({});
    }, staleMs);
  }

  function startRefresh(options: { force?: boolean }): Promise<void> {
    if (inFlight != null) return inFlight;
    inFlight = refreshSnapshot(deps, snapshot, options).then(async (next) => {
      lastError = null;
      await persist(next);
    }).catch((error: unknown) => {
      lastError = errorText(error);
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
      const stale = snapshot == null || options?.refresh === true || ageMs(snapshot.fetchedAt, now) > staleMs;
      if (stale) void startRefresh({ force: options?.refresh === true });
      else if (cancelTimer == null && inFlight == null) scheduleBackgroundRefresh();
      const localPrs = await deps.listRecentPullRequests();
      const response = buildInboxResponse(snapshot ?? emptySnapshot(now), localPrs, now, inFlight != null);
      if (snapshot == null) response.fetchedAt = null;
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
