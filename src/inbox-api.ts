import type { GitHubNotification, InboxItem, InboxLatestActivity, InboxResponse, InboxSubjectKind, InboxSubjectSnapshot, InboxTier, StoredPullRequest, ViewerPullRequest, ViewerPullRequestScope } from "./types.js";

export type InboxSubjectRef = { repo: string; number: number; kind: InboxSubjectKind };

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
  now: () => string;
  /** Serve a cached inbox for this long unless the caller asks for a refresh; 0 disables. */
  cacheMs?: number;
};

export type InboxApi = {
  inbox: (options?: { refresh?: boolean }) => Promise<InboxResponse>;
  done: (payload: Record<string, unknown>) => Promise<{ done: string[] }>;
  mute: (payload: Record<string, unknown>) => Promise<{ muted: string[] }>;
};

const HOUR_MS = 60 * 60 * 1000;
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

export function createInboxApi(deps: InboxApiDeps): InboxApi {
  const cacheMs = deps.cacheMs ?? 0;
  let cached: { at: number; response: InboxResponse } | null = null;
  // Concurrent callers (a browser tab plus an auto-refresh, or two tabs) share one GitHub round
  // trip; running them side by side doubles ~90 gh calls and trips GitHub's secondary rate limit.
  let inFlight: Promise<InboxResponse> | null = null;

  async function load(): Promise<InboxResponse> {
    const warnings: string[] = [];
    const [notifications, login, localPrs] = await Promise.all([deps.fetchNotifications(), deps.fetchViewerLogin(), deps.listRecentPullRequests()]);
    const refs = new Map<string, InboxSubjectRef>();
    for (const notification of notifications) {
      if (notification.subjectNumber == null || notification.subjectKind === "other") continue;
      refs.set(subjectKey(notification.repo, notification.subjectNumber), { repo: notification.repo, number: notification.subjectNumber, kind: notification.subjectKind });
    }
    const viewerPrs = (scope: ViewerPullRequestScope) => (login == null ? Promise.resolve([]) : deps.fetchViewerPullRequests(login, scope).catch((error: unknown) => {
      warnings.push(`Could not load your ${scope === "open" ? "open" : "recently closed"} PRs: ${error instanceof Error ? error.message : String(error)}`);
      return [] as ViewerPullRequest[];
    }));
    const [snapshots, myPrs, recentlyClosedPrs] = await Promise.all([
      refs.size === 0 ? Promise.resolve([]) : deps.fetchSubjectSnapshots([...refs.values()]).catch((error: unknown) => {
        warnings.push(`Could not load PR/issue state: ${error instanceof Error ? error.message : String(error)}`);
        return [] as InboxSubjectSnapshot[];
      }),
      viewerPrs("open"),
      viewerPrs("recently-closed"),
    ]);
    const localKeys = new Set(localPrs.map((pr) => pr.key));
    const withLocalKey = (pr: ViewerPullRequest): ViewerPullRequest => ({ ...pr, localPrKey: localKeys.has(localPrKey(pr.repo, pr.number)) ? localPrKey(pr.repo, pr.number) : null });
    const fetchedAt = deps.now();
    const ranked = rankInbox(notifications, snapshots, localPrs, fetchedAt);
    const commentUrlByThread = new Map(notifications.filter((notification) => notification.latestCommentUrl != null).map((notification) => [notification.id, notification.latestCommentUrl as string] as const));
    const enrichable = ranked.items.filter((item) => ENRICHED_TIERS.has(item.tier) && commentUrlByThread.has(item.id)).slice(0, LATEST_ACTIVITY_LIMIT);
    const latestByUrl = enrichable.length === 0 ? new Map<string, InboxLatestActivity>() : await deps.fetchLatestActivity(enrichable.map((item) => commentUrlByThread.get(item.id) as string), login).catch((error: unknown) => {
      warnings.push(`Could not load latest activity: ${error instanceof Error ? error.message : String(error)}`);
      return new Map<string, InboxLatestActivity>();
    });
    const latestByThread = new Map<string, InboxLatestActivity>();
    for (const item of enrichable) {
      const latest = latestByUrl.get(commentUrlByThread.get(item.id) as string);
      if (latest != null) latestByThread.set(item.id, latest);
    }
    const items = applyLatestActivity(ranked.items, latestByThread);
    return {
      login,
      fetchedAt,
      items,
      tiers: tierCounts(items),
      myPrs: myPrs.map(withLocalKey),
      recentlyClosedPrs: recentlyClosedPrs.map(withLocalKey),
      warnings,
    };
  }

  function dropFromCache(ids: string[]): void {
    if (cached == null) return;
    const gone = new Set(ids);
    const items = cached.response.items.filter((item) => !gone.has(item.id));
    cached = { at: cached.at, response: { ...cached.response, items, tiers: tierCounts(items) } };
  }

  return {
    async inbox(options) {
      const now = Date.now();
      if (!options?.refresh && cached != null && now - cached.at < cacheMs) return cached.response;
      if (inFlight != null) return inFlight;
      inFlight = load().then((response) => {
        if (cacheMs > 0) cached = { at: now, response };
        return response;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    async done(payload) {
      const ids = threadIds(payload);
      await Promise.all(ids.map((id) => deps.markNotificationDone(id)));
      dropFromCache(ids);
      return { done: ids };
    },
    async mute(payload) {
      const ids = threadIds(payload);
      await Promise.all(ids.map(async (id) => {
        await deps.unsubscribeNotification(id);
        await deps.markNotificationDone(id);
      }));
      dropFromCache(ids);
      return { muted: ids };
    },
  };
}
