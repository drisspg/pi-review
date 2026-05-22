import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import type { AiReviewRecord, AppState, FileReviewState, FocusScanRecord, ReviewMemoryProfile, ReviewMemoryRecord, StoredPullRequest } from "./types.js";

const STATE_PATH = resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "state.json");
const REVIEW_MEMORY_NOTES_PATH = resolve(homedir(), "agent_notes", "findings", "pi_review_preferences.md");
const REVIEW_PROFILE_PATH = resolve(homedir(), "agent_notes", "findings", "pi_review_profile.md");

const maxFocusScansPerPr = 20;
const maxAiReviewsPerPr = 20;
const maxReviewMemoryRecords = 10_000;
const maxReviewMemoryPromptRecords = 12;
const maxReviewMemoryDistillationRecords = 250;
const maxReviewMemoryPromptPatchChars = 4_000;
const maxReviewMemoryDistillationPatchChars = 12_000;

const emptyState = (): AppState => ({ prs: [], fileReviews: [], focusScans: [], aiReviews: [], reviewMemory: [], reviewProfile: null });

export async function readState(): Promise<AppState> {
  if (!existsSync(STATE_PATH)) return emptyState();
  const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<AppState>;
  return { prs: state.prs ?? [], fileReviews: state.fileReviews ?? [], focusScans: state.focusScans ?? [], aiReviews: state.aiReviews ?? [], reviewMemory: state.reviewMemory ?? [], reviewProfile: state.reviewProfile ?? null };
}

async function writeState(state: AppState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, STATE_PATH);
}

async function writeReviewMemoryNotes(records: ReviewMemoryRecord[]): Promise<void> {
  await mkdir(dirname(REVIEW_MEMORY_NOTES_PATH), { recursive: true });
  await writeFile(REVIEW_MEMORY_NOTES_PATH, reviewMemoryPrompt(records), "utf8");
}

async function writeReviewProfile(profile: ReviewMemoryProfile): Promise<void> {
  await mkdir(dirname(REVIEW_PROFILE_PATH), { recursive: true });
  await writeFile(REVIEW_PROFILE_PATH, profile.text, "utf8");
}

function reviewMemoryLocation(comment: ReviewMemoryRecord["comments"][number]): string {
  const line = comment.line == null ? "file" : comment.startLine != null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : `${comment.line}`;
  return `${comment.path}:${line}`;
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated ${text.length - maxChars} chars …`;
}

function reviewMemoryChangeSetBlock(record: ReviewMemoryRecord, maxPatchChars: number): string {
  if (record.changeSet == null) return "No change-set snapshot stored for this review.";
  const header = [record.changeSet.title, record.changeSet.url, record.changeSet.source].filter((value) => value != null && value.length > 0).join("\n");
  const files = record.changeSet.files.map((file) => {
    const stats = [file.status, file.additions == null ? null : `+${file.additions}`, file.deletions == null ? null : `-${file.deletions}`].filter(Boolean).join(" ");
    return `### ${file.path}${stats.length > 0 ? ` (${stats})` : ""}\n${file.patch == null || file.patch.length === 0 ? "Patch unavailable." : truncateText(file.patch, maxPatchChars)}`;
  }).join("\n\n");
  return `${header.length > 0 ? `${header}\n\n` : ""}${files.length > 0 ? files : "No files stored."}`;
}

export function reviewMemoryPrompt(records: ReviewMemoryRecord[]): string {
  if (records.length === 0) return "No review preference examples have been captured yet.";
  const examples = records.slice(0, maxReviewMemoryPromptRecords).map((record, index) => {
    const comments = record.comments.length === 0 ? "No inline comments." : record.comments.map((comment) => `- ${reviewMemoryLocation(comment)}: ${comment.body}`).join("\n");
    const body = record.body.trim().length === 0 ? "No overall body." : record.body.trim();
    return `## Example ${index + 1}: ${record.prKey} (${record.event})\nOverall review body:\n${body}\n\nInline comments:\n${comments}\n\nChange-set context:\n${reviewMemoryChangeSetBlock(record, maxReviewMemoryPromptPatchChars)}`;
  });
  return `# Driss review preference examples\n\nThese are examples of review comments Driss actually submitted. Use them as positive examples of what he considered worth saying. Prefer similar specificity, severity, and style. Do not copy comments verbatim unless the same issue is present. Avoid over-indexing on one example when the current diff points elsewhere.\n\n${examples.join("\n\n")}`;
}

function reviewMemoryDistillationSource(records: ReviewMemoryRecord[]): string {
  if (records.length === 0) return "No review preference examples have been captured yet.";
  return records.slice(0, maxReviewMemoryDistillationRecords).map((record, index) => {
    const comments = record.comments.length === 0 ? "No inline comments." : record.comments.map((comment) => `- ${reviewMemoryLocation(comment)}: ${comment.body}`).join("\n");
    const body = record.body.trim().length === 0 ? "No overall body." : record.body.trim();
    return `## Raw review ${index + 1}: ${record.prKey} (${record.event}, ${record.createdAt})\nOverall review body:\n${body}\n\nInline comments:\n${comments}\n\nChange-set context:\n${reviewMemoryChangeSetBlock(record, maxReviewMemoryDistillationPatchChars)}`;
  }).join("\n\n");
}

export async function currentReviewMemoryDistillationSource(): Promise<string> {
  return reviewMemoryDistillationSource((await readState()).reviewMemory);
}

export async function currentReviewMemoryContext(): Promise<string> {
  const state = await readState();
  const profile = state.reviewProfile?.text.trim();
  return [
    profile == null || profile.length === 0 ? "# Driss review profile\n\nNo distilled review profile has been generated yet." : profile,
    reviewMemoryPrompt(state.reviewMemory),
  ].join("\n\n---\n\n");
}

export async function currentReviewProfile(): Promise<ReviewMemoryProfile | null> {
  return (await readState()).reviewProfile;
}

export async function listReviewMemoryRecords(limit = 50): Promise<ReviewMemoryRecord[]> {
  return (await readState()).reviewMemory.slice(0, limit);
}

export async function reviewMemoryStats(): Promise<{ recordCount: number; inlineCommentCount: number; prCount: number; latestCreatedAt: string | null; profileUpdatedAt: string | null; profileSourceRecordCount: number | null }> {
  const state = await readState();
  return {
    recordCount: state.reviewMemory.length,
    inlineCommentCount: state.reviewMemory.reduce((total, record) => total + record.comments.length, 0),
    prCount: new Set(state.reviewMemory.map((record) => record.prKey)).size,
    latestCreatedAt: state.reviewMemory[0]?.createdAt ?? null,
    profileUpdatedAt: state.reviewProfile?.updatedAt ?? null,
    profileSourceRecordCount: state.reviewProfile?.sourceRecordCount ?? null,
  };
}

export async function saveReviewProfile(text: string): Promise<ReviewMemoryProfile> {
  const state = await readState();
  const profile: ReviewMemoryProfile = { text: text.trim(), sourceRecordCount: state.reviewMemory.length, updatedAt: new Date().toISOString() };
  state.reviewProfile = profile;
  await writeState(state);
  await writeReviewProfile(profile);
  return profile;
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

export async function listFocusScans(prKey: string): Promise<FocusScanRecord[]> {
  return (await readState()).focusScans.filter((scan) => scan.prKey === prKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

export async function listAiReviews(prKey: string): Promise<AiReviewRecord[]> {
  return (await readState()).aiReviews.filter((review) => review.prKey === prKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

export async function saveReviewMemory(record: Omit<ReviewMemoryRecord, "id" | "createdAt">): Promise<ReviewMemoryRecord> {
  const state = await readState();
  const next: ReviewMemoryRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
  state.reviewMemory = [next, ...state.reviewMemory].slice(0, maxReviewMemoryRecords);
  await writeState(state);
  await writeReviewMemoryNotes(state.reviewMemory);
  return next;
}

export async function currentReviewMemoryPrompt(): Promise<string> {
  return currentReviewMemoryContext();
}

export async function removePullRequest(prKey: string): Promise<void> {
  const state = await readState();
  state.prs = state.prs.filter((pr) => pr.key !== prKey);
  state.fileReviews = state.fileReviews.filter((review) => review.prKey !== prKey);
  state.focusScans = state.focusScans.filter((scan) => scan.prKey !== prKey);
  state.aiReviews = state.aiReviews.filter((review) => review.prKey !== prKey);
  await writeState(state);
}
