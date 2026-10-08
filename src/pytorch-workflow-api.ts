import type { InboxItem, PullRequestRef, PytorchAssessmentView, PytorchAssessorStatus, PytorchPreReviewAssessment, PytorchPreReviewRecommendation, PytorchIssueSnapshot, PytorchPullSnapshot, PytorchQueueIssue, PytorchQueuePr, PytorchQueuesResponse, PytorchSearchResult, PytorchStageInfo, StoredPullRequest } from "./types.js";

/**
 * PyTorch's label-driven issue/PR workflow (CONTRIBUTING.md "Issue and PR Workflow",
 * docs/source/community/maintainer_guide.md). Queue queries mirror the maintainer guide's
 * links verbatim, scoped to the repo so GitHub's API search matches the web search.
 */
export const PYTORCH_REPO = "pytorch/pytorch";
export const ISSUE_TRIAGE_LABELS = ["needs reproduction", "needs research", "needs design", "actionable", "won't fix"] as const;
export type IssueTriageLabel = (typeof ISSUE_TRIAGE_LABELS)[number];
/** Maintainers fully triage issues within one week of creation. */
export const TRIAGE_SLA_DAYS = 7;
export const WHY_CLOSED_URL = "https://github.com/pytorch/pytorch/blob/main/CONTRIBUTING.md#why-was-my-issue-or-pr-closed";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STALE_MS = 5 * 60 * 1000;
const MODULE_LABELS_TTL_MS = 24 * 60 * 60 * 1000;
const EXCERPT_CHARS = 700;
const REASSESS_AFTER_MS = 6 * 60 * 60 * 1000;

function quoteLabel(label: string): string {
  return /[\s:']/.test(label) ? `label:"${label}"` : `label:${label}`;
}

function excludeLabels(labels: readonly string[]): string {
  return labels.map((label) => `-${quoteLabel(label)}`).join(" ");
}

export function pytorchQueueQueries(modules: string[]): { preReview: string; review: string; triage: Array<{ module: string; query: string }> } {
  const repo = `repo:${PYTORCH_REPO}`;
  return {
    preReview: `${repo} is:pr is:open -is:draft review-requested:@me label:triaged ${excludeLabels(["in progress", "ready for review", "missing actionable issue"])}`,
    review: `${repo} is:pr is:open review-requested:@me ${quoteLabel("ready for review")} ${excludeLabels(["missing actionable issue"])}`,
    triage: modules.map((module) => ({ module, query: `${repo} is:issue is:open label:triaged ${quoteLabel(module)} ${excludeLabels(ISSUE_TRIAGE_LABELS)}` })),
  };
}

/** The same search on github.com, so every queue has a one-click escape hatch. */
export function githubSearchUrl(query: string): string {
  const kind = /\bis:issue\b/.test(query) ? "issues" : "pulls";
  return `https://github.com/${PYTORCH_REPO}/${kind}?q=${encodeURIComponent(query.replace(`repo:${PYTORCH_REPO} `, ""))}`;
}

function has(labels: string[], name: string): boolean {
  return labels.some((label) => label.toLowerCase() === name);
}

/**
 * Pure stage classifier for the PR lifecycle table. Labels are bot-managed, so precedence
 * follows the lifecycle order: terminal states, GitHub draft, the TEMPORARY `missing
 * actionable issue` holding label, approval, then the most advanced workflow label.
 */
export function classifyPullRequestStage(pr: { labels: string[]; isDraft: boolean; state: "OPEN" | "MERGED" | "CLOSED"; reviewDecision: PytorchPullSnapshot["reviewDecision"] }): PytorchStageInfo {
  const flags = { stale: has(pr.labels, "stale"), highPriority: has(pr.labels, "high priority"), needsSendBack: false };
  if (pr.state === "MERGED") return { ...flags, stage: "merged", label: "Merged", actor: "none", next: "Nothing left to do." };
  if (pr.state === "CLOSED") return { ...flags, stage: "closed", label: "Closed", actor: "none", next: "Closed; further discussion belongs on the linked issue." };
  if (pr.isDraft) return { ...flags, stage: "draft", label: "Draft", actor: "author", next: "Author marks the PR ready once the description and code can be looked at." };
  if (has(pr.labels, "missing actionable issue")) return { ...flags, stage: "missing-issue", label: "Missing actionable issue", actor: "author", next: "Link an actionable issue or name the sponsoring maintainer; a maintainer can also remove the label." };
  if (pr.reviewDecision === "APPROVED") return { ...flags, stage: "accepted", label: "Accepted", actor: "author", next: "Author fixes CI failures and comments @pytorchbot merge." };
  if (has(pr.labels, "ready for review")) {
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { ...flags, needsSendBack: true, stage: "ready-for-review", label: "Changes requested", actor: "author", next: "Re-add `in progress` so automated review runs again (TEMPORARY: not automatic yet)." };
    return { ...flags, stage: "ready-for-review", label: "Ready for review", actor: "reviewers", next: "One assigned reviewer does the full review." };
  }
  if (has(pr.labels, "in progress")) return { ...flags, stage: "in-progress", label: "In progress", actor: "author", next: "Author iterates until automated review passes and swaps in `ready for review`." };
  if (has(pr.labels, "triaged")) return { ...flags, stage: "pre-review", label: "Pre-review", actor: "reviewers", next: "Every assigned reviewer accepts: \ud83d\udc4d the description or comment @pytorchbot pre-review accept." };
  return { ...flags, stage: "awaiting-triage", label: "Awaiting triage", actor: "bot", next: "Triage assigns one reviewer per module and adds `triaged`." };
}

export function toQueueIssue(issue: PytorchIssueSnapshot, nowIso: string): PytorchQueueIssue {
  const ageDays = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(issue.createdAt)) / DAY_MS));
  return { ...issue, ageDays, overdue: ageDays >= TRIAGE_SLA_DAYS, highPriority: has(issue.labels, "high priority") };
}

/** Strip template comments and collapse whitespace so a pre-review fits in a glance. */
export function bodyExcerpt(body: string): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}\u2026` : text;
}

function localPrKey(number: number): string {
  return `github.com/${PYTORCH_REPO}#${number}`;
}

/** Issue numbers named in the description (`#123` or a pytorch/pytorch issue URL), minus GitHub-parsed closing references. */
export function mentionedIssues(body: string, linked: number[]): number[] {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const found = new Set<number>();
  for (const match of text.matchAll(/(?:github\.com\/pytorch\/pytorch\/issues\/|(?<![\w/&])#)(\d{3,})\b/g)) found.add(Number.parseInt(match[1], 10));
  return [...found].filter((number) => !linked.includes(number)).slice(0, 5);
}

function assessmentView(assessment: PytorchPreReviewAssessment | undefined, prUpdatedAt: string): PytorchAssessmentView | null {
  if (assessment == null) return null;
  return { ...assessment, outdated: assessment.prUpdatedAt != null && prUpdatedAt > assessment.prUpdatedAt };
}

export function toQueuePr(pr: PytorchPullSnapshot, localKeys: Set<string>, assessment?: PytorchPreReviewAssessment, chatTurns = 0): PytorchQueuePr {
  const { body, id: _id, ...rest } = pr;
  return { ...rest, chatTurns, bodyExcerpt: bodyExcerpt(body), mentionedIssues: mentionedIssues(body, pr.linkedIssues.map((issue) => issue.number)), stage: classifyPullRequestStage(pr), localPrKey: localKeys.has(localPrKey(pr.number)) ? localPrKey(pr.number) : null, assessment: assessmentView(assessment, pr.updatedAt) };
}

/**
 * GitHub's search index lags behind state changes, so an `is:open -is:draft` search can still
 * return a PR closed seconds ago; trust each node's own state. Hidden PRs stay out until they
 * see activity after being hidden.
 */
export function visibleQueue(result: PytorchSearchResult<PytorchPullSnapshot>, options: { excludeDrafts: boolean; hidden: Record<string, string> }): PytorchSearchResult<PytorchPullSnapshot> {
  const items = result.items.filter((pr) => {
    if (pr.state !== "OPEN" || (options.excludeDrafts && pr.isDraft)) return false;
    const hiddenAt = options.hidden[pr.number];
    return hiddenAt == null || pr.updatedAt > hiddenAt;
  });
  return { total: Math.max(items.length, result.total - (result.items.length - items.length)), items };
}

function byRecentlyUpdated(items: PytorchQueuePr[]): PytorchQueuePr[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Most recently updated first. Accepted pre-reviews stay in GitHub's queue until every reviewer accepts, so they sink below the ones still owed. */
function sortPreReview(items: PytorchQueuePr[]): PytorchQueuePr[] {
  return byRecentlyUpdated(items).sort((a, b) => Number(a.viewerThumbsUp) - Number(b.viewerThumbsUp));
}

const RECOMMENDATIONS: Record<string, PytorchPreReviewRecommendation> = { accept: "accept", "back to draft": "draft", close: "close" };

/**
 * Parse the pre-review answer contract shared by the `pytorch-pre-review` prompt and offline
 * assessors: a required `Recommendation: Accept | Back to draft | Close` line, optional
 * `Why`, `Pre-conditions`, `Notes` bullets, and a ```comment fenced block.
 */
export function parsePreReviewAssessment(markdown: string): Omit<PytorchPreReviewAssessment, "number" | "source" | "assessedAt" | "prUpdatedAt"> {
  const recommendation = /Recommendation:\s*\**\s*(Accept|Back to draft|Close)\b/i.exec(markdown)?.[1]?.toLowerCase();
  if (recommendation == null) throw new Error("Assessment must contain a \"Recommendation: Accept | Back to draft | Close\" line");
  const field = (name: string) => new RegExp(`^\\**${name}[^:\\n]*:\\**\\s*(.+)$`, "im").exec(markdown)?.[1]?.trim() ?? null;
  const notesBlock = /^\**Notes[^:\n]*:\**\s*\n((?:[ \t]*[-*] .*\n?)+)/im.exec(markdown)?.[1] ?? "";
  return {
    recommendation: RECOMMENDATIONS[recommendation],
    why: field("Why") ?? "",
    preconditions: field("Pre-conditions"),
    notes: notesBlock.split("\n").map((line) => line.replace(/^[ \t]*[-*] /, "").trim()).filter((line) => line.length > 0),
    comment: /```comment[^\n]*\n([\s\S]*?)```/.exec(markdown)?.[1]?.trim() || null,
  };
}

export type PytorchStore = {
  version: 1;
  modules: string[];
  snapshot: {
    login: string | null;
    fetchedAt: string;
    /** Modules the triage queues were fetched for; a mismatch with `modules` forces a refresh. */
    modules: string[];
    preReview: PytorchSearchResult<PytorchPullSnapshot>;
    review: PytorchSearchResult<PytorchPullSnapshot>;
    triage: Array<PytorchSearchResult<PytorchIssueSnapshot> & { module: string }>;
    warnings: string[];
  } | null;
  /** Saved pre-review suggestions keyed by PR number; optional so older store files still load. */
  assessments?: Record<string, PytorchPreReviewAssessment>;
  /** PRs the viewer kicked out of their queues (number -> hiddenAt); they return on newer PR activity. */
  hidden?: Record<string, string>;
  /** Inline pre-review chat threads keyed by PR number. */
  chats?: Record<string, Array<{ role: "user" | "assistant"; text: string; at: string }>>;
};

export type PytorchWorkflowDeps = {
  fetchViewerLogin: () => Promise<string | null>;
  searchPullRequests: (query: string) => Promise<PytorchSearchResult<PytorchPullSnapshot>>;
  searchIssues: (query: string) => Promise<PytorchSearchResult<PytorchIssueSnapshot>>;
  fetchPullRequest: (ref: PullRequestRef) => Promise<PytorchPullSnapshot>;
  listModuleLabels: () => Promise<string[]>;
  addReaction: (ref: PullRequestRef, content: "+1") => Promise<void>;
  addLabels: (ref: PullRequestRef, labels: string[]) => Promise<void>;
  addComment: (ref: PullRequestRef, body: string) => Promise<void>;
  closeIssue: (ref: PullRequestRef) => Promise<void>;
  convertToDraft: (ref: PullRequestRef) => Promise<void>;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  /** pytorch/pytorch issue notifications, read live from the inbox snapshot on every response. */
  listIssueNotifications: () => Promise<InboxItem[]>;
  /** Background assessor state, if one is wired; read per response. */
  assessorStatus?: () => PytorchAssessorStatus | null;
  /** Called after each queue refresh so a background assessor can pick up new PRs. */
  onQueuesRefreshed?: () => void;
  /** Run one checkout-free assessment now (serialized with the background assessor). */
  assessNow?: (number: number) => Promise<void>;
  /** Successful workflow writes, for the review activity ledger. */
  onAction?: (input: { action: "pre-review:accept" | "pre-review:draft" | "pre-review:close" | "send-back" | `triage:${string}`; number: number; title: string | null; url: string }) => void;
  readStore: () => Promise<PytorchStore | null>;
  writeStore: (store: PytorchStore) => Promise<void>;
  now: () => string;
  logger?: { info: (scope: string, message: string, data?: Record<string, unknown>) => void; warn: (scope: string, message: string, data?: Record<string, unknown>) => void };
  staleMs?: number;
};

export type PytorchPrStatus = { pr: PytorchQueuePr; login: string | null; viewerIsAuthor: boolean; viewerIsReviewer: boolean };

export type PytorchWorkflowApi = {
  queues: (options?: { refresh?: boolean }) => Promise<PytorchQueuesResponse>;
  setModules: (payload: Record<string, unknown>) => Promise<{ modules: string[] }>;
  moduleLabels: () => Promise<{ labels: string[] }>;
  prStatus: (payload: Record<string, unknown>) => Promise<PytorchPrStatus>;
  acceptPreReview: (payload: Record<string, unknown>) => Promise<{ number: number; accepted: true }>;
  declinePreReview: (payload: Record<string, unknown>) => Promise<{ number: number; outcome: "draft" | "close" }>;
  triageIssue: (payload: Record<string, unknown>) => Promise<{ number: number; label: IssueTriageLabel }>;
  sendBackToInProgress: (payload: Record<string, unknown>) => Promise<{ number: number }>;
  saveAssessment: (payload: Record<string, unknown>) => Promise<{ assessment: PytorchPreReviewAssessment }>;
  /** Owed pre-reviews (queue order) without a usable suggestion; reads the cached snapshot, never GitHub. */
  assessmentCandidates: () => Promise<Array<{ number: number; updatedAt: string }>>;
  requestAssessment: (payload: Record<string, unknown>) => Promise<{ assessment: PytorchPreReviewAssessment }>;
  readAssessment: (number: number) => Promise<PytorchPreReviewAssessment | null>;
  readChat: (number: number) => Promise<NonNullable<PytorchStore["chats"]>[string]>;
  writeChat: (number: number, turns: NonNullable<PytorchStore["chats"]>[string]) => Promise<void>;
  /** Local-only: kick a PR out of the queues until it sees new activity. Never touches GitHub. */
  hidePr: (payload: Record<string, unknown>) => Promise<{ number: number; hidden: boolean }>;
  settle: () => Promise<void>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortError(error: unknown): string {
  const text = errorText(error);
  return (/gh: (.+)$/m.exec(text)?.[1] ?? text).trim().slice(0, 160);
}

function pytorchRef(number: number): PullRequestRef {
  const [owner, repo] = PYTORCH_REPO.split("/");
  return { host: "github.com", owner, repo, number };
}

function requiredNumber(payload: Record<string, unknown>): number {
  const value = payload.number;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error("Expected a positive integer number");
  return value;
}

function requiredText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Expected ${key}`);
  return value.trim();
}

/** Accepts `https://github.com/pytorch/pytorch/pull/123`, `pytorch/pytorch#123`, or a bare number. */
export function parsePytorchPrNumber(input: unknown): number {
  if (typeof input === "number" && Number.isInteger(input) && input > 0) return input;
  const text = typeof input === "string" ? input.trim() : "";
  const match = /^(?:https?:\/\/github\.com\/pytorch\/pytorch\/(?:pull|issues)\/|(?:github\.com\/)?pytorch\/pytorch#)?(\d+)(?:[/?#].*)?$/i.exec(text);
  if (match == null) throw new Error("Expected a pytorch/pytorch PR URL or number");
  return Number.parseInt(match[1], 10);
}

export function normalizeModules(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("Expected modules to be an array of label names");
  const modules: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") throw new Error("Expected modules to be label names");
    const label = value.trim().replace(/\s+/g, " ");
    if (!/^(module|oncall): \S/.test(label)) throw new Error(`"${label}" is not a module label; expected "module: \u2026" or "oncall: \u2026"`);
    if (!modules.includes(label)) modules.push(label);
  }
  if (modules.length > 12) throw new Error("Track at most 12 modules; each one costs a GitHub search per refresh");
  return modules;
}

/** Reject reasons follow the maintainer guide: always explain, and link the FAQ when closing. */
export function declineComment(reason: string, outcome: "draft" | "close"): string {
  const trimmed = reason.trim();
  if (outcome === "draft") return `${trimmed}\n\nMoving this back to draft for now; mark it ready for review once that is addressed.`;
  return trimmed.includes(WHY_CLOSED_URL) ? trimmed : `${trimmed}\n\nSee [Why was my issue or PR closed?](${WHY_CLOSED_URL}).`;
}

export function createPytorchWorkflowApi(deps: PytorchWorkflowDeps): PytorchWorkflowApi {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  let store: PytorchStore | null = null;
  let loaded: Promise<void> | null = null;
  let inFlight: Promise<void> | null = null;
  let moduleLabels: { at: number; labels: string[] } | null = null;

  function load(): Promise<void> {
    loaded ??= deps.readStore().then((stored) => {
      if (store == null) store = stored?.version === 1 ? stored : { version: 1, modules: [], snapshot: null };
    }).catch((error: unknown) => {
      deps.logger?.warn("pytorch", "could not read persisted workflow store", { error: errorText(error) });
      store ??= { version: 1, modules: [], snapshot: null };
    });
    return loaded;
  }

  async function persist(next: PytorchStore): Promise<void> {
    store = next;
    try {
      await deps.writeStore(next);
    } catch (error) {
      deps.logger?.warn("pytorch", "could not persist workflow store", { error: errorText(error) });
    }
  }

  function current(): PytorchStore {
    return store ?? { version: 1, modules: [], snapshot: null };
  }

  /** Sequential on purpose: 2 + modules searches per refresh, never a burst against the shared secondary rate limit. */
  async function refresh(): Promise<void> {
    const modules = current().modules;
    const queries = pytorchQueueQueries(modules);
    const previous = current().snapshot;
    const warnings: string[] = [];
    const empty = { total: 0, items: [] };
    async function attempt<T>(label: string, work: () => Promise<T>, fallback: T): Promise<T> {
      try {
        return await work();
      } catch (error) {
        warnings.push(`Could not load ${label}: ${shortError(error)}`);
        return fallback;
      }
    }
    const login = await deps.fetchViewerLogin();
    const preReview = await attempt("pre-review queue", () => deps.searchPullRequests(queries.preReview), previous?.preReview ?? empty);
    const review = await attempt("review queue", () => deps.searchPullRequests(queries.review), previous?.review ?? empty);
    const triage: NonNullable<PytorchStore["snapshot"]>["triage"] = [];
    for (const { module, query } of queries.triage) {
      const fallback = previous?.triage.find((entry) => entry.module === module) ?? { module, ...empty };
      triage.push({ module, ...(await attempt(`${module} triage queue`, () => deps.searchIssues(query), fallback)) });
    }
    deps.logger?.info("pytorch", "queues refreshed", { preReview: preReview.total, review: review.total, modules: modules.length, warnings: warnings.length });
    await persist({ ...current(), snapshot: { login, fetchedAt: deps.now(), modules, preReview, review, triage, warnings } });
    deps.onQueuesRefreshed?.();
  }

  function startRefresh(): Promise<void> {
    inFlight ??= refresh().catch((error: unknown) => {
      deps.logger?.warn("pytorch", "queue refresh failed", { error: errorText(error) });
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function updateSnapshot(update: (snapshot: NonNullable<PytorchStore["snapshot"]>) => NonNullable<PytorchStore["snapshot"]>): Promise<void> {
    await load();
    const snapshot = current().snapshot;
    if (snapshot != null) await persist({ ...current(), snapshot: update(snapshot) });
  }

  function snapshotTitle(number: number): string | null {
    const snapshot = current().snapshot;
    const items = [...(snapshot?.preReview.items ?? []), ...(snapshot?.review.items ?? []), ...(snapshot?.triage.flatMap((entry) => entry.items) ?? [])];
    return items.find((item) => item.number === number)?.title ?? null;
  }

  function reportAction(action: Parameters<NonNullable<PytorchWorkflowDeps["onAction"]>>[0]["action"], number: number, kind: "pull" | "issues"): void {
    deps.onAction?.({ action, number, title: snapshotTitle(number), url: `https://github.com/${PYTORCH_REPO}/${kind}/${number}` });
  }

  function withoutPr(result: PytorchSearchResult<PytorchPullSnapshot>, number: number): PytorchSearchResult<PytorchPullSnapshot> {
    const items = result.items.filter((item) => item.number !== number);
    return { total: Math.max(0, result.total - (result.items.length - items.length)), items };
  }

  async function response(): Promise<PytorchQueuesResponse> {
    const { modules, snapshot } = current();
    const now = deps.now();
    const [localPrs, issueNotifications] = await Promise.all([deps.listRecentPullRequests(), deps.listIssueNotifications().catch((error: unknown) => {
      deps.logger?.warn("pytorch", "could not read issue notifications", { error: errorText(error) });
      return [];
    })]);
    const localKeys = new Set(localPrs.map((pr) => pr.key));
    const queries = pytorchQueueQueries(modules);
    const assessments = current().assessments ?? {};
    const hidden = current().hidden ?? {};
    const preReview = visibleQueue(snapshot?.preReview ?? { total: 0, items: [] }, { excludeDrafts: true, hidden });
    const review = visibleQueue(snapshot?.review ?? { total: 0, items: [] }, { excludeDrafts: false, hidden });
    return {
      login: snapshot?.login ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      refreshing: inFlight != null,
      modules,
      preReview: { total: preReview.total, items: sortPreReview(preReview.items.map((pr) => toQueuePr(pr, localKeys, assessments[pr.number], current().chats?.[pr.number]?.length ?? 0))), githubUrl: githubSearchUrl(queries.preReview) },
      review: { total: review.total, items: byRecentlyUpdated(review.items.map((pr) => toQueuePr(pr, localKeys, undefined, current().chats?.[pr.number]?.length ?? 0))), githubUrl: githubSearchUrl(queries.review) },
      triage: queries.triage.map(({ module, query }) => {
        const entry = snapshot?.triage.find((candidate) => candidate.module === module);
        // Newest first: the one-week SLA is about fresh issues, and long-triaged backlogs would otherwise bury them.
        const items = (entry?.items ?? []).map((issue) => toQueueIssue(issue, now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { module, total: entry?.total ?? 0, items, githubUrl: githubSearchUrl(query) };
      }),
      issueNotifications,
      assessor: deps.assessorStatus?.() ?? null,
      warnings: snapshot?.warnings ?? [],
    };
  }

  return {
    async queues(options) {
      await load();
      const { modules, snapshot } = current();
      const moduleMismatch = snapshot != null && snapshot.modules.join("\n") !== modules.join("\n");
      if (snapshot == null) await startRefresh();
      else if (options?.refresh === true || moduleMismatch || Date.parse(deps.now()) - Date.parse(snapshot.fetchedAt) > staleMs) void startRefresh();
      return response();
    },
    async setModules(payload) {
      const modules = normalizeModules(payload.modules);
      await load();
      await persist({ ...current(), modules });
      void startRefresh();
      return { modules };
    },
    async moduleLabels() {
      const now = Date.parse(deps.now());
      if (moduleLabels == null || now - moduleLabels.at > MODULE_LABELS_TTL_MS) moduleLabels = { at: now, labels: await deps.listModuleLabels() };
      return { labels: moduleLabels.labels };
    },
    async prStatus(payload) {
      const number = parsePytorchPrNumber(payload.prUrl ?? payload.number);
      const [snapshot, login] = await Promise.all([deps.fetchPullRequest(pytorchRef(number)), deps.fetchViewerLogin(), load()]);
      const localKeys = new Set((await deps.listRecentPullRequests()).map((pr) => pr.key));
      return { pr: toQueuePr(snapshot, localKeys, current().assessments?.[number]), login, viewerIsAuthor: login != null && snapshot.author === login, viewerIsReviewer: login != null && snapshot.reviewers.includes(login) };
    },
    async acceptPreReview(payload) {
      const number = requiredNumber(payload);
      await deps.addReaction(pytorchRef(number), "+1");
      reportAction("pre-review:accept", number, "pull");
      await updateSnapshot((snapshot) => ({ ...snapshot, preReview: { ...snapshot.preReview, items: snapshot.preReview.items.map((item) => item.number === number ? { ...item, viewerThumbsUp: true } : item) } }));
      return { number, accepted: true };
    },
    async declinePreReview(payload) {
      const number = requiredNumber(payload);
      const outcome = payload.outcome;
      if (outcome !== "draft" && outcome !== "close") throw new Error("Expected outcome to be draft or close");
      const ref = pytorchRef(number);
      await deps.addComment(ref, declineComment(requiredText(payload, "reason"), outcome));
      await (outcome === "draft" ? deps.convertToDraft(ref) : deps.closeIssue(ref));
      reportAction(outcome === "draft" ? "pre-review:draft" : "pre-review:close", number, "pull");
      await updateSnapshot((snapshot) => ({ ...snapshot, preReview: withoutPr(snapshot.preReview, number) }));
      return { number, outcome };
    },
    async triageIssue(payload) {
      const number = requiredNumber(payload);
      const label = payload.label;
      if (typeof label !== "string" || !(ISSUE_TRIAGE_LABELS as readonly string[]).includes(label)) throw new Error(`Expected label to be one of ${ISSUE_TRIAGE_LABELS.join(", ")}`);
      const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
      if (label === "won't fix" && comment.length === 0) throw new Error("won't fix is final: explain the reason in a comment");
      const ref = pytorchRef(number);
      await deps.addLabels(ref, [label]);
      if (comment.length > 0) await deps.addComment(ref, comment);
      reportAction(`triage:${label}`, number, "issues");
      await updateSnapshot((snapshot) => ({
        ...snapshot,
        triage: snapshot.triage.map((entry) => {
          const items = entry.items.filter((item) => item.number !== number);
          return { ...entry, items, total: Math.max(0, entry.total - (entry.items.length - items.length)) };
        }),
      }));
      return { number, label: label as IssueTriageLabel };
    },
    async sendBackToInProgress(payload) {
      const number = requiredNumber(payload);
      await deps.addLabels(pytorchRef(number), ["in progress"]);
      reportAction("send-back", number, "pull");
      await updateSnapshot((snapshot) => ({ ...snapshot, review: withoutPr(snapshot.review, number) }));
      return { number };
    },
    async saveAssessment(payload) {
      const number = requiredNumber(payload);
      const parsed = parsePreReviewAssessment(requiredText(payload, "markdown"));
      await load();
      const known = current().snapshot?.preReview.items.find((item) => item.number === number)?.updatedAt ?? null;
      const prUpdatedAt = typeof payload.prUpdatedAt === "string" && payload.prUpdatedAt.length > 0 ? payload.prUpdatedAt : known;
      const assessment: PytorchPreReviewAssessment = { number, ...parsed, source: typeof payload.source === "string" && payload.source.trim().length > 0 ? payload.source.trim() : "AI", assessedAt: deps.now(), prUpdatedAt };
      await persist({ ...current(), assessments: { ...current().assessments, [number]: assessment } });
      return { assessment };
    },
    async readAssessment(number) {
      await load();
      return current().assessments?.[number] ?? null;
    },
    async readChat(number) {
      await load();
      return current().chats?.[number] ?? [];
    },
    async writeChat(number, turns) {
      await load();
      const chats = { ...current().chats };
      if (turns.length === 0) delete chats[number];
      else chats[number] = turns;
      await persist({ ...current(), chats });
    },
    async hidePr(payload) {
      const number = requiredNumber(payload);
      const hidden = payload.hidden !== false;
      await load();
      const next = { ...current().hidden };
      if (hidden) next[number] = deps.now();
      else delete next[number];
      await persist({ ...current(), hidden: next });
      return { number, hidden };
    },
    async requestAssessment(payload) {
      const number = requiredNumber(payload);
      if (deps.assessNow == null) throw new Error("Pre-review assessments are not available on this server");
      await deps.assessNow(number);
      const assessment = current().assessments?.[number];
      if (assessment == null) throw new Error(`No assessment was saved for #${number}`);
      return { assessment };
    },
    async assessmentCandidates() {
      await load();
      const assessments = current().assessments ?? {};
      const nowMs = Date.parse(deps.now());
      const queue = visibleQueue(current().snapshot?.preReview ?? { total: 0, items: [] }, { excludeDrafts: true, hidden: current().hidden ?? {} });
      const items = sortPreReview(queue.items.map((pr) => toQueuePr(pr, new Set(), assessments[pr.number])));
      // Re-assess an outdated suggestion only after REASSESS_AFTER_MS, so bot comments bumping updatedAt don't cause churn.
      return items.filter((pr) => !pr.viewerThumbsUp && pr.stage.stage === "pre-review" && (pr.assessment == null || (pr.assessment.outdated && nowMs - Date.parse(pr.assessment.assessedAt) > REASSESS_AFTER_MS))).map((pr) => ({ number: pr.number, updatedAt: pr.updatedAt }));
    },
    async settle() {
      await load();
      while (inFlight != null) await inFlight;
    },
  };
}
