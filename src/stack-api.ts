import type { PullRequestRef } from "./types.js";

/**
 * Stacked PRs as a first-class review object. Stack membership comes from the PR body's stack
 * block, which both supported tools write top-first with `__->__` marking the current PR:
 *   - stack-pr / sp:  "Stacked PRs:" followed by "* #N" rows, ended by "--- --- ---"
 *   - ghstack:        "Stack from [ghstack](...) (oldest at bottom):" followed by "* #N" rows
 * Member status (landed/open, draft, review decision, the viewer's latest review vs head) is one
 * batched GitHub query, cached briefly so the header strip and Pi's tool stay cheap.
 */
export type StackFormat = "sp" | "ghstack";
export type ParsedStack = { format: StackFormat; /** Bottom (oldest, lands first) to top. */ members: number[]; current: number | null };

export type StackMemberState = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  landedLabel: boolean;
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  headSha: string;
  additions: number;
  deletions: number;
  /** The viewer's most recent submitted review, if any. */
  viewerReview: { state: string; commitSha: string | null; submittedAt: string } | null;
};

export type StackMemberStatus = "landed" | "closed" | "approved" | "changes-requested" | "draft" | "needs-review";
export type StackMember = Omit<StackMemberState, "landedLabel" | "viewerReview"> & {
  position: number;
  isCurrent: boolean;
  status: StackMemberStatus;
  /** Viewer's review: "current" = at the PR's head, "stale" = an older revision, null = never reviewed. */
  viewerReview: { state: string; freshness: "current" | "stale" } | null;
};
export type StackView = {
  format: StackFormat;
  repo: string;
  members: StackMember[];
  currentPosition: number | null;
  /** Lowest member that has not landed: what lands (and usually needs review) next. */
  nextToLand: number | null;
  counts: { total: number; landed: number; reviewedByViewer: number; approved: number };
};

export type StackApiDeps = {
  /** Body of the PR the stack is read from (local snapshot is fine; members are refreshed live). */
  readBody: (ref: PullRequestRef) => Promise<string | null>;
  fetchMembers: (repo: string, numbers: number[]) => Promise<StackMemberState[]>;
  now: () => number;
  ttlMs?: number;
};

export type StackApi = {
  stack: (payload: Record<string, unknown>) => Promise<{ stack: StackView | null }>;
};

const ROW = /^\s*[*-]\s*(?:(?:__)?->(?:__)?\s*)?(?:#(\d+)|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))\b/;

/** Locate the stack block: the parsed stack plus the line range it occupies (header through last row). */
function locateStack(lines: string[]): { stack: ParsedStack; start: number; end: number } | null {
  const header = lines.findIndex((line) => /^\s*Stacked PRs:\s*$/i.test(line) || /^\s*Stack from \[ghstack\]/i.test(line));
  if (header < 0) return null;
  const format: StackFormat = /ghstack/i.test(lines[header]) ? "ghstack" : "sp";
  const topFirst: number[] = [];
  let current: number | null = null;
  let end = header + 1;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (line.trim().length === 0 && topFirst.length === 0) continue;
    const match = ROW.exec(line);
    if (match == null) break;
    const number = Number.parseInt(match[1] ?? match[2], 10);
    if (/->/.test(line)) current = number;
    if (!topFirst.includes(number)) topFirst.push(number);
  }
  if (topFirst.length < 2) return null;
  return { stack: { format, members: topFirst.reverse(), current }, start: header, end };
}

/** Parse a stack block from a PR body; returns null when the body has none (or fewer than two members). */
export function parseStack(body: string): ParsedStack | null {
  return locateStack(body.replace(/\r\n/g, "\n").split("\n"))?.stack ?? null;
}

/**
 * Split a PR body into its stack block and the author's actual description, so the description can
 * render without a tall list of bare PR numbers (the header stack strip shows membership instead).
 * Drops the sp/stack-pr "--- --- ---" (or a plain "---") separator that follows the block.
 */
export function splitStackBlock(body: string): { stack: ParsedStack | null; description: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const located = locateStack(lines);
  if (located == null) return { stack: null, description: body.trim() };
  let resume = located.end;
  while (resume < lines.length && lines[resume].trim().length === 0) resume += 1;
  if (resume < lines.length && /^\s*-{3,}(\s+-{3,})*\s*$/.test(lines[resume])) resume += 1;
  const description = [lines.slice(0, located.start), lines.slice(resume)].map((part) => part.join("\n").trim()).filter((part) => part.length > 0).join("\n\n");
  return { stack: located.stack, description };
}

export function memberStatus(member: Pick<StackMemberState, "state" | "landedLabel" | "isDraft" | "reviewDecision">): StackMemberStatus {
  if (member.state === "MERGED" || (member.state === "CLOSED" && member.landedLabel)) return "landed";
  if (member.state === "CLOSED") return "closed";
  if (member.isDraft) return "draft";
  if (member.reviewDecision === "APPROVED") return "approved";
  if (member.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  return "needs-review";
}

export function buildStackView(parsed: ParsedStack, repo: string, states: StackMemberState[], currentNumber: number): StackView {
  const byNumber = new Map(states.map((state) => [state.number, state] as const));
  const members: StackMember[] = parsed.members.flatMap((number, position) => {
    const state = byNumber.get(number);
    if (state == null) return [];
    const { landedLabel: _landed, viewerReview, ...rest } = state;
    return [{
      ...rest,
      position,
      isCurrent: number === currentNumber,
      status: memberStatus(state),
      viewerReview: viewerReview == null ? null : { state: viewerReview.state, freshness: viewerReview.commitSha != null && viewerReview.commitSha === state.headSha ? "current" : "stale" },
    }];
  });
  const current = members.find((member) => member.isCurrent);
  return {
    format: parsed.format,
    repo,
    members,
    currentPosition: current?.position ?? null,
    nextToLand: members.find((member) => member.status !== "landed" && member.status !== "closed")?.number ?? null,
    counts: {
      total: members.length,
      landed: members.filter((member) => member.status === "landed").length,
      reviewedByViewer: members.filter((member) => member.viewerReview?.freshness === "current").length,
      approved: members.filter((member) => member.status === "approved").length,
    },
  };
}

function parseRef(input: unknown): PullRequestRef {
  const match = typeof input === "string" ? /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(input.trim()) : null;
  if (match == null) throw new Error("Expected prUrl like https://github.com/owner/repo/pull/123");
  return { host: "github.com", owner: match[1], repo: match[2], number: Number.parseInt(match[3], 10) };
}

export function createStackApi(deps: StackApiDeps): StackApi {
  const ttlMs = deps.ttlMs ?? 2 * 60 * 1000;
  const cache = new Map<string, { at: number; states: StackMemberState[] }>();
  return {
    async stack(payload) {
      const ref = parseRef(payload.prUrl);
      const body = await deps.readBody(ref);
      const parsed = body == null ? null : parseStack(body);
      if (parsed == null) return { stack: null };
      const repo = `${ref.owner}/${ref.repo}`;
      const cacheKey = `${repo}:${parsed.members.join(",")}`;
      const cached = cache.get(cacheKey);
      const states = cached != null && payload.refresh !== true && deps.now() - cached.at < ttlMs ? cached.states : await deps.fetchMembers(repo, parsed.members);
      if (cached?.states !== states) cache.set(cacheKey, { at: deps.now(), states });
      return { stack: buildStackView(parsed, repo, states, ref.number) };
    },
  };
}
