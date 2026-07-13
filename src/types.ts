export type PullRequestRef = {
  host: string;
  owner: string;
  repo: string;
  number: number;
};

export type GitHubUser = { login?: string } | null;

export type GitHubRepo = {
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

export type DraftReviewComment = {
  id: string;
  path: string;
  line: number | null;
  startLine?: number | null;
  side: "RIGHT" | "LEFT";
  body: string;
};

export type DraftReview = {
  prKey: string;
  headSha: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: DraftReviewComment[];
  updatedAt: string;
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

export type AiReviewMessageRecord = {
  role: "user" | "pi";
  text: string;
  title?: string;
  kind?: "general-review" | "chat";
};

export type AiReviewRecord = {
  id: string;
  prKey: string;
  headSha: string;
  answer: string;
  messages?: AiReviewMessageRecord[];
  createdAt: string;
  updatedAt: string;
};

export type ReviewMemoryComment = {
  path: string;
  line: number | null;
  startLine?: number | null;
  side: "RIGHT" | "LEFT";
  body: string;
};

export type ReviewMemoryFile = {
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
  worktreeDir?: string;
};

export type AppState = {
  prs: StoredPullRequest[];
  fileReviews: FileReviewState[];
  draftReviews: DraftReview[];
  focusScans: FocusScanRecord[];
  aiReviews: AiReviewRecord[];
  reviewMemory: ReviewMemoryRecord[];
  reviewProfile: ReviewMemoryProfile | null;
};
