export type PullRequestRef = {
  host: string;
  owner: string;
  repo: string;
  number: number;
};

type GitHubUser = { login?: string } | null;

type GitHubRepo = {
  full_name: string;
  clone_url: string;
  html_url: string;
  default_branch?: string;
};

export type PullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  user?: GitHubUser;
  merged?: boolean;
  labels?: Array<{ name?: string }>;
  base: { ref: string; sha: string; repo: GitHubRepo };
  head: { ref: string; sha: string; repo: GitHubRepo | null };
};

export type PullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type PullFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  generated?: boolean;
};

export type CommitCheckFailure = { name: string; url: string | null };

export type CommitChecks = {
  total: number;
  success: number;
  failure: number;
  pending: number;
  neutral: number;
  failures: CommitCheckFailure[];
};

export type PullReviewComment = {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: "RIGHT" | "LEFT" | null;
  original_side?: "RIGHT" | "LEFT" | null;
  in_reply_to_id?: number | null;
  body: string;
  html_url: string;
  user?: GitHubUser;
  updated_at?: string;
  thread_id?: string;
  thread_resolved?: boolean;
};

export type PullIssueComment = {
  id: number;
  body: string;
  html_url: string;
  user?: GitHubUser;
  updated_at?: string;
};

export type PullRequestReviewSummary = {
  id: number;
  body: string;
  html_url: string;
  user?: GitHubUser;
  state: string;
  commit_id?: string | null;
  submitted_at?: string | null;
  updated_at?: string;
};

export type StoredPullRequest = {
  key: string;
  ref: PullRequestRef;
  url: string;
  title: string;
  body: string | null;
  state: string;
  merged?: boolean;
  author: string | null;
  baseSha: string;
  headSha: string;
  filesChanged: number | null;
  existingCommentCount: number | null;
  lastOpenedAt: string;
  lastReviewedHeadSha: string | null;
  lastReviewEvent: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" | null;
  reviewDecision: PullRequestReviewDecision;
};

export type FileReviewState = {
  prKey: string;
  path: string;
  fingerprint: string;
  viewed: boolean;
  updatedAt: string;
};

type InlineReviewComment = {
  path: string;
  line: number | null;
  startLine?: number | null;
  side: "RIGHT" | "LEFT";
  body: string;
};

export type DraftReviewComment = InlineReviewComment & { id: string };

export type DraftReview = {
  prKey: string;
  headSha: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: DraftReviewComment[];
  updatedAt: string;
};

export type GitHubDraftCommentInput = InlineReviewComment;

export type GitHubDraftComment = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  subjectType: "LINE" | "FILE";
  body: string;
  url: string;
};

export type GitHubPendingReview = {
  id: string;
  body: string;
  comments: GitHubDraftComment[];
  updatedAt: string;
};

export type GitHubPendingReviewLookup = {
  pullRequestId: string;
  review: GitHubPendingReview | null;
};

export type FocusAreaReviewState = {
  viewed: boolean;
  collapsed: boolean;
  updatedAt: string;
};

export type FocusScanRecord = {
  id: string;
  prKey: string;
  headSha: string;
  answer: string;
  areaStates: Record<string, FocusAreaReviewState>;
  createdAt: string;
  updatedAt: string;
};

export type PiPromptEvent =
  | { type: "thinking"; delta: string }
  | { type: "tool"; phase: "start" | "update" | "end"; toolCallId: string; toolName: string; detail: string; output?: string; isError?: boolean };

export type AiReviewMessageRecord = {
  role: "user" | "pi" | "thinking" | "tool";
  text: string;
  title?: string;
  kind?: "general-review" | "chat";
  toolCallId?: string;
  toolName?: string;
  toolStatus?: "running" | "success" | "error";
};

type GuideStepState = {
  reviewed: boolean;
  updatedAt: string;
};

export type GuideReviewRecord = {
  id: string;
  prKey: string;
  headSha: string;
  answer: string;
  stepStates?: Record<string, GuideStepState>;
  createdAt: string;
  updatedAt: string;
};

export type AiReviewRecord = GuideReviewRecord & {
  messages?: AiReviewMessageRecord[];
};

export type ReviewMemoryComment = InlineReviewComment;

type ReviewMemoryFile = {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};

export type ReviewMemoryChangeSet = {
  title?: string;
  url?: string;
  source?: string;
  files: ReviewMemoryFile[];
};

export type ReviewMemoryRecord = {
  id: string;
  prKey: string;
  headSha: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: ReviewMemoryComment[];
  changeSet?: ReviewMemoryChangeSet;
  disposition?: "published" | "archived";
  createdAt: string;
};

export type ReviewMemoryProfile = {
  text: string;
  sourceRecordCount: number;
  updatedAt: string;
};

export type PullRequestReviewData = {
  pr: StoredPullRequest;
  raw: PullRequest;
  files: PullFile[];
  comments: PullReviewComment[];
  issueComments: PullIssueComment[];
  reviewSummaries: PullRequestReviewSummary[];
  fileReviews: FileReviewState[];
};

export type PullRequestReviewResponse = PullRequestReviewData & {
  draftReview: DraftReview | null;
  focusScan: FocusScanRecord | null;
  focusScans: FocusScanRecord[];
  aiReview: AiReviewRecord | null;
  aiReviews: AiReviewRecord[];
  guideReview: GuideReviewRecord | null;
  overview: GuideReviewRecord | null;
  worktreeDir?: string;
};

export type AppState = {
  prs: StoredPullRequest[];
  fileReviews: FileReviewState[];
  draftReviews: DraftReview[];
  focusScans: FocusScanRecord[];
  aiReviews: AiReviewRecord[];
  guideReviews: GuideReviewRecord[];
  overviews: GuideReviewRecord[];
  reviewMemory: ReviewMemoryRecord[];
  reviewProfile: ReviewMemoryProfile | null;
};

// Home-page inbox: GitHub notifications ranked into triage tiers plus the viewer's own open PRs.
export type CheckRollupState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
export type InboxSubjectKind = "pr" | "issue" | "other";
export type InboxSubjectState = "OPEN" | "CLOSED" | "MERGED" | null;

/** One raw GitHub notification thread, normalized from `GET /notifications`. */
export type GitHubNotification = {
  id: string;
  reason: string;
  unread: boolean;
  updatedAt: string;
  repo: string;
  subjectKind: InboxSubjectKind;
  subjectNumber: number | null;
  subjectTitle: string;
  latestCommentUrl: string | null;
};

/** Current state of a notification's PR/issue, batched through GraphQL so closed threads can be demoted. */
export type InboxSubjectSnapshot = {
  key: string;
  kind: InboxSubjectKind;
  url: string;
  state: InboxSubjectState;
  isDraft: boolean;
  author: string | null;
  reviewDecision: PullRequestReviewDecision;
  checks: CheckRollupState;
  updatedAt: string | null;
};

export type ViewerPullRequestScope = "open" | "recently-closed";

export type ViewerPullRequest = {
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  closedAt: string | null;
  isDraft: boolean;
  reviewDecision: PullRequestReviewDecision;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: CheckRollupState;
  failingChecks: string[];
  reviewers: string[];
  updatedAt: string;
  headSha: string;
  localPrKey: string | null;
};

export type InboxTier = "needs-you" | "review-requests" | "your-prs" | "fyi" | "resolved";

/** Who acted last on a thread; resolved from the notification's latest_comment_url for the top tiers only. */
export type InboxLatestActivity = { author: string | null; bot: boolean; pingsViewer: boolean; snippet: string; url: string };

export type InboxItem = {
  id: string;
  tier: InboxTier;
  score: number;
  reason: string;
  title: string;
  repo: string;
  number: number | null;
  kind: InboxSubjectKind;
  url: string;
  updatedAt: string;
  state: InboxSubjectState;
  isDraft: boolean;
  author: string | null;
  reviewDecision: PullRequestReviewDecision;
  checks: CheckRollupState;
  localPrKey: string | null;
  latest: InboxLatestActivity | null;
  why: string[];
};

export type InboxResponse = {
  login: string | null;
  fetchedAt: string;
  items: InboxItem[];
  tiers: Record<InboxTier, number>;
  myPrs: ViewerPullRequest[];
  recentlyClosedPrs: ViewerPullRequest[];
  warnings: string[];
};
