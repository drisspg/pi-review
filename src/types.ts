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

export type PullFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

export type PullReviewComment = {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: "RIGHT" | "LEFT" | null;
  original_side?: "RIGHT" | "LEFT" | null;
  body: string;
  html_url: string;
  user?: GitHubUser;
  updated_at?: string;
};

export type StoredPullRequest = {
  key: string;
  ref: PullRequestRef;
  url: string;
  title: string;
  state: string;
  author: string | null;
  baseSha: string;
  headSha: string;
  filesChanged: number | null;
  existingCommentCount: number | null;
  lastOpenedAt: string;
  lastReviewedHeadSha: string | null;
};

export type FileReviewState = {
  prKey: string;
  path: string;
  fingerprint: string;
  viewed: boolean;
  updatedAt: string;
};

export type PullRequestReviewData = {
  pr: StoredPullRequest;
  files: PullFile[];
  comments: PullReviewComment[];
  fileReviews: FileReviewState[];
};

export type AppState = {
  prs: StoredPullRequest[];
  fileReviews: FileReviewState[];
};
