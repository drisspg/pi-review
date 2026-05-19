import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import type { AiReviewRecord, AppState, FileReviewState, FocusScanRecord, StoredPullRequest } from "./types.js";

const STATE_PATH = resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "state.json");

const maxFocusScansPerPr = 20;
const maxAiReviewsPerPr = 20;

const emptyState = (): AppState => ({ prs: [], fileReviews: [], focusScans: [], aiReviews: [] });

export async function readState(): Promise<AppState> {
  if (!existsSync(STATE_PATH)) return emptyState();
  const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<AppState>;
  return { prs: state.prs ?? [], fileReviews: state.fileReviews ?? [], focusScans: state.focusScans ?? [], aiReviews: state.aiReviews ?? [] };
}

async function writeState(state: AppState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, STATE_PATH);
}

export async function listRecentPullRequests(): Promise<StoredPullRequest[]> {
  return (await readState()).prs.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

export async function upsertPullRequest(pr: StoredPullRequest): Promise<StoredPullRequest> {
  const state = await readState();
  const previous = state.prs.find((stored) => stored.key === pr.key);
  state.prs = [{ ...pr, lastReviewedHeadSha: previous?.lastReviewedHeadSha ?? pr.lastReviewedHeadSha, lastReviewEvent: previous?.lastReviewEvent ?? pr.lastReviewEvent, reviewDecision: pr.reviewDecision ?? previous?.reviewDecision ?? null }, ...state.prs.filter((stored) => stored.key !== pr.key)];
  await writeState(state);
  return state.prs[0];
}

export async function markPullRequestReviewed(prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]): Promise<StoredPullRequest | null> {
  const state = await readState();
  const index = state.prs.findIndex((pr) => pr.key === prKey);
  if (index === -1) return null;
  state.prs[index] = { ...state.prs[index], lastReviewedHeadSha: headSha, lastReviewEvent: event };
  await writeState(state);
  return state.prs[index];
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

export async function latestFocusScan(prKey: string): Promise<FocusScanRecord | null> {
  return (await readState()).focusScans.filter((scan) => scan.prKey === prKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function saveFocusScan(scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>): Promise<FocusScanRecord> {
  const state = await readState();
  const previous = scan.id == null ? null : state.focusScans.find((stored) => stored.id === scan.id);
  const now = new Date().toISOString();
  const next: FocusScanRecord = {
    id: scan.id ?? randomUUID(),
    prKey: scan.prKey,
    headSha: scan.headSha,
    answer: scan.answer,
    areaStates: scan.areaStates,
    createdAt: previous?.createdAt ?? scan.createdAt ?? now,
    updatedAt: now,
  };
  state.focusScans = [next, ...state.focusScans.filter((stored) => stored.id !== next.id)];
  const counts = new Map<string, number>();
  state.focusScans = state.focusScans.filter((stored) => {
    const count = counts.get(stored.prKey) ?? 0;
    counts.set(stored.prKey, count + 1);
    return count < maxFocusScansPerPr;
  });
  await writeState(state);
  return next;
}

export async function latestAiReview(prKey: string): Promise<AiReviewRecord | null> {
  return (await readState()).aiReviews.filter((review) => review.prKey === prKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export async function saveAiReview(review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>): Promise<AiReviewRecord> {
  const state = await readState();
  const previous = review.id == null ? null : state.aiReviews.find((stored) => stored.id === review.id);
  const now = new Date().toISOString();
  const next: AiReviewRecord = {
    id: review.id ?? randomUUID(),
    prKey: review.prKey,
    headSha: review.headSha,
    answer: review.answer,
    messages: review.messages,
    createdAt: previous?.createdAt ?? review.createdAt ?? now,
    updatedAt: now,
  };
  state.aiReviews = [next, ...state.aiReviews.filter((stored) => stored.id !== next.id)];
  const counts = new Map<string, number>();
  state.aiReviews = state.aiReviews.filter((stored) => {
    const count = counts.get(stored.prKey) ?? 0;
    counts.set(stored.prKey, count + 1);
    return count < maxAiReviewsPerPr;
  });
  await writeState(state);
  return next;
}

export async function removePullRequest(prKey: string): Promise<void> {
  const state = await readState();
  state.prs = state.prs.filter((pr) => pr.key !== prKey);
  state.fileReviews = state.fileReviews.filter((review) => review.prKey !== prKey);
  state.focusScans = state.focusScans.filter((scan) => scan.prKey !== prKey);
  state.aiReviews = state.aiReviews.filter((review) => review.prKey !== prKey);
  await writeState(state);
}
