import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import type { AppState, FileReviewState, StoredPullRequest } from "./types.js";

const STATE_PATH = resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "state.json");

const emptyState = (): AppState => ({ prs: [], fileReviews: [] });

export async function readState(): Promise<AppState> {
  if (!existsSync(STATE_PATH)) return emptyState();
  const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<AppState>;
  return { prs: state.prs ?? [], fileReviews: state.fileReviews ?? [] };
}

async function writeState(state: AppState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function listRecentPullRequests(): Promise<StoredPullRequest[]> {
  return (await readState()).prs.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function upsertPullRequest(pr: StoredPullRequest): Promise<StoredPullRequest> {
  const state = await readState();
  const previous = state.prs.find((stored) => stored.key === pr.key);
  state.prs = [{ ...pr, lastReviewedHeadSha: previous?.lastReviewedHeadSha ?? pr.lastReviewedHeadSha }, ...state.prs.filter((stored) => stored.key !== pr.key)];
  await writeState(state);
  return state.prs[0];
}

export async function listFileReviews(prKey: string): Promise<FileReviewState[]> {
  return (await readState()).fileReviews.filter((review) => review.prKey === prKey);
}

export async function setFileViewed(review: FileReviewState): Promise<FileReviewState> {
  const state = await readState();
  state.fileReviews = [review, ...state.fileReviews.filter((stored) => !(stored.prKey === review.prKey && stored.path === review.path && stored.fingerprint === review.fingerprint))];
  await writeState(state);
  return review;
}

export async function removePullRequest(prKey: string): Promise<void> {
  const state = await readState();
  state.prs = state.prs.filter((pr) => pr.key !== prKey);
  state.fileReviews = state.fileReviews.filter((review) => review.prKey !== prKey);
  await writeState(state);
}
