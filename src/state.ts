import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import type { AiReviewRecord, AppState, DraftReview, FileReviewState, FocusScanRecord, ReviewMemoryProfile, ReviewMemoryRecord, StoredPullRequest } from "./types.js";

const STATE_PATH = process.env.PI_REVIEW_STATE_PATH == null
  ? resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "state.json")
  : resolve(process.env.PI_REVIEW_STATE_PATH);
const REVIEW_MEMORY_NOTES_PATH = resolve(homedir(), "agent_notes", "findings", "pi_review_preferences.md");
const REVIEW_PROFILE_PATH = resolve(homedir(), "agent_notes", "findings", "pi_review_profile.md");

const maxFocusScansPerPr = 20;
const maxAiReviewsPerPr = 20;
const maxReviewMemoryRecords = 10_000;
const maxReviewMemoryPromptRecords = 12;
const maxReviewMemoryDistillationRecords = 250;
const maxReviewMemoryPromptPatchChars = 4_000;
const maxReviewMemoryDistillationPatchChars = 12_000;

const emptyState = (): AppState => ({ prs: [], fileReviews: [], draftReviews: [], focusScans: [], aiReviews: [], reviewMemory: [], reviewProfile: null });

export type StateStorePaths = {
  statePath: string;
  reviewMemoryNotesPath: string;
  reviewProfilePath: string;
};

export type StateStoreRuntime = {
  exists: (path: string) => boolean;
  mkdir: (path: string) => Promise<void>;
  now: () => string;
  readFile: (path: string) => Promise<string>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  uuid: () => string;
  writeFile: (path: string, data: string) => Promise<void>;
};

export type StateStore = {
  readState: () => Promise<AppState>;
  currentReviewMemoryDistillationSource: () => Promise<string>;
  currentReviewMemoryContext: () => Promise<string>;
  currentReviewProfile: () => Promise<ReviewMemoryProfile | null>;
  listReviewMemoryRecords: (limit?: number) => Promise<ReviewMemoryRecord[]>;
  reviewMemoryStats: () => Promise<{ recordCount: number; inlineCommentCount: number; prCount: number; latestCreatedAt: string | null; profileUpdatedAt: string | null; profileSourceRecordCount: number | null }>;
  saveReviewProfile: (text: string) => Promise<ReviewMemoryProfile>;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  upsertPullRequest: (pr: StoredPullRequest) => Promise<StoredPullRequest>;
  markPullRequestReviewed: (prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]) => Promise<StoredPullRequest | null>;
  listFileReviews: (prKey: string) => Promise<FileReviewState[]>;
  setFileViewed: (review: FileReviewState) => Promise<FileReviewState>;
  getDraftReview: (prKey: string) => Promise<DraftReview | null>;
  saveDraftReview: (review: DraftReview) => Promise<DraftReview>;
  listFocusScans: (prKey: string) => Promise<FocusScanRecord[]>;
  saveFocusScan: (scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>) => Promise<FocusScanRecord>;
  listAiReviews: (prKey: string) => Promise<AiReviewRecord[]>;
  saveAiReview: (review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>) => Promise<AiReviewRecord>;
  saveReviewMemory: (record: Omit<ReviewMemoryRecord, "id" | "createdAt">) => Promise<ReviewMemoryRecord>;
  currentReviewMemoryPrompt: () => Promise<string>;
  removePullRequest: (prKey: string) => Promise<void>;
};

const defaultPaths: StateStorePaths = {
  statePath: STATE_PATH,
  reviewMemoryNotesPath: REVIEW_MEMORY_NOTES_PATH,
  reviewProfilePath: REVIEW_PROFILE_PATH,
};

const defaultRuntime: StateStoreRuntime = {
  exists: existsSync,
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  now: () => new Date().toISOString(),
  async readFile(path) {
    return await readFile(path, "utf8");
  },
  async rename(oldPath, newPath) {
    await rename(oldPath, newPath);
  },
  uuid: randomUUID,
  async writeFile(path, data) {
    await writeFile(path, data, "utf8");
  },
};

function normalizeState(state: Partial<AppState>): AppState {
  return { prs: state.prs ?? [], fileReviews: state.fileReviews ?? [], draftReviews: state.draftReviews ?? [], focusScans: state.focusScans ?? [], aiReviews: state.aiReviews ?? [], reviewMemory: state.reviewMemory ?? [], reviewProfile: state.reviewProfile ?? null };
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

export function createStateStore(runtime: StateStoreRuntime = defaultRuntime, paths: StateStorePaths = defaultPaths): StateStore {
  let mutationQueue = Promise.resolve();

  async function readState(): Promise<AppState> {
    if (!runtime.exists(paths.statePath)) return emptyState();
    return normalizeState(JSON.parse(await runtime.readFile(paths.statePath)) as Partial<AppState>);
  }

  async function writeState(state: AppState): Promise<void> {
    await runtime.mkdir(dirname(paths.statePath));
    const tempPath = `${paths.statePath}.${runtime.uuid()}.tmp`;
    await runtime.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    await runtime.rename(tempPath, paths.statePath);
  }

  function mutateState<T>(mutation: (state: AppState) => Promise<T> | T): Promise<T> {
    const result = mutationQueue.then(async () => mutation(await readState()));
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function writeReviewMemoryNotes(records: ReviewMemoryRecord[]): Promise<void> {
    await runtime.mkdir(dirname(paths.reviewMemoryNotesPath));
    await runtime.writeFile(paths.reviewMemoryNotesPath, reviewMemoryPrompt(records));
  }

  async function writeReviewProfile(profile: ReviewMemoryProfile): Promise<void> {
    await runtime.mkdir(dirname(paths.reviewProfilePath));
    await runtime.writeFile(paths.reviewProfilePath, profile.text);
  }

  async function currentReviewMemoryDistillationSource(): Promise<string> {
    return reviewMemoryDistillationSource((await readState()).reviewMemory);
  }

  async function currentReviewMemoryContext(): Promise<string> {
    const state = await readState();
    const profile = state.reviewProfile?.text.trim();
    return [
      profile == null || profile.length === 0 ? "# Driss review profile\n\nNo distilled review profile has been generated yet." : profile,
      reviewMemoryPrompt(state.reviewMemory),
    ].join("\n\n---\n\n");
  }

  async function currentReviewProfile(): Promise<ReviewMemoryProfile | null> {
    return (await readState()).reviewProfile;
  }

  async function listReviewMemoryRecords(limit = 50): Promise<ReviewMemoryRecord[]> {
    return (await readState()).reviewMemory.slice(0, limit);
  }

  async function reviewMemoryStats(): Promise<{ recordCount: number; inlineCommentCount: number; prCount: number; latestCreatedAt: string | null; profileUpdatedAt: string | null; profileSourceRecordCount: number | null }> {
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

  async function saveReviewProfile(text: string): Promise<ReviewMemoryProfile> {
    return mutateState(async (state) => {
      const profile: ReviewMemoryProfile = { text: text.trim(), sourceRecordCount: state.reviewMemory.length, updatedAt: runtime.now() };
      state.reviewProfile = profile;
      await writeState(state);
      await writeReviewProfile(profile);
      return profile;
    });
  }

  async function listRecentPullRequests(): Promise<StoredPullRequest[]> {
    return (await readState()).prs.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async function upsertPullRequest(pr: StoredPullRequest): Promise<StoredPullRequest> {
    return mutateState(async (state) => {
      const previous = state.prs.find((stored) => stored.key === pr.key);
      state.prs = [{ ...pr, lastReviewedHeadSha: previous?.lastReviewedHeadSha ?? pr.lastReviewedHeadSha, lastReviewEvent: previous?.lastReviewEvent ?? pr.lastReviewEvent, reviewDecision: pr.reviewDecision ?? previous?.reviewDecision ?? null }, ...state.prs.filter((stored) => stored.key !== pr.key)];
      await writeState(state);
      return state.prs[0];
    });
  }

  async function markPullRequestReviewed(prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]): Promise<StoredPullRequest | null> {
    return mutateState(async (state) => {
      const index = state.prs.findIndex((pr) => pr.key === prKey);
      if (index === -1) return null;
      state.prs[index] = { ...state.prs[index], lastReviewedHeadSha: headSha, lastReviewEvent: event };
      await writeState(state);
      return state.prs[index];
    });
  }

  async function listFileReviews(prKey: string): Promise<FileReviewState[]> {
    return (await readState()).fileReviews.filter((review) => review.prKey === prKey);
  }

  async function setFileViewed(review: FileReviewState): Promise<FileReviewState> {
    return mutateState(async (state) => {
      state.fileReviews = [review, ...state.fileReviews.filter((stored) => !(stored.prKey === review.prKey && stored.path === review.path && stored.fingerprint === review.fingerprint))];
      await writeState(state);
      return review;
    });
  }

  async function getDraftReview(prKey: string): Promise<DraftReview | null> {
    return (await readState()).draftReviews.find((review) => review.prKey === prKey) ?? null;
  }

  async function saveDraftReview(review: DraftReview): Promise<DraftReview> {
    return mutateState(async (state) => {
      state.draftReviews = [review, ...state.draftReviews.filter((stored) => stored.prKey !== review.prKey)];
      await writeState(state);
      return review;
    });
  }

  async function listFocusScans(prKey: string): Promise<FocusScanRecord[]> {
    return (await readState()).focusScans.filter((scan) => scan.prKey === prKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function saveFocusScan(scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>): Promise<FocusScanRecord> {
    return mutateState(async (state) => {
      const previous = scan.id == null ? null : state.focusScans.find((stored) => stored.id === scan.id);
      const now = runtime.now();
      const next: FocusScanRecord = {
        id: scan.id ?? runtime.uuid(),
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
    });
  }

  async function listAiReviews(prKey: string): Promise<AiReviewRecord[]> {
    return (await readState()).aiReviews.filter((review) => review.prKey === prKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function saveAiReview(review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>): Promise<AiReviewRecord> {
    return mutateState(async (state) => {
      const previous = review.id == null ? null : state.aiReviews.find((stored) => stored.id === review.id);
      const now = runtime.now();
      const next: AiReviewRecord = {
        id: review.id ?? runtime.uuid(),
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
    });
  }

  async function saveReviewMemory(record: Omit<ReviewMemoryRecord, "id" | "createdAt">): Promise<ReviewMemoryRecord> {
    return mutateState(async (state) => {
      const next: ReviewMemoryRecord = { ...record, id: runtime.uuid(), createdAt: runtime.now() };
      state.reviewMemory = [next, ...state.reviewMemory].slice(0, maxReviewMemoryRecords);
      await writeState(state);
      await writeReviewMemoryNotes(state.reviewMemory);
      return next;
    });
  }

  async function currentReviewMemoryPrompt(): Promise<string> {
    return currentReviewMemoryContext();
  }

  async function removePullRequest(prKey: string): Promise<void> {
    await mutateState(async (state) => {
      state.prs = state.prs.filter((pr) => pr.key !== prKey);
      state.fileReviews = state.fileReviews.filter((review) => review.prKey !== prKey);
      state.draftReviews = state.draftReviews.filter((review) => review.prKey !== prKey);
      state.focusScans = state.focusScans.filter((scan) => scan.prKey !== prKey);
      state.aiReviews = state.aiReviews.filter((review) => review.prKey !== prKey);
      await writeState(state);
    });
  }

  return { readState, currentReviewMemoryDistillationSource, currentReviewMemoryContext, currentReviewProfile, listReviewMemoryRecords, reviewMemoryStats, saveReviewProfile, listRecentPullRequests, upsertPullRequest, markPullRequestReviewed, listFileReviews, setFileViewed, getDraftReview, saveDraftReview, listFocusScans, saveFocusScan, listAiReviews, saveAiReview, saveReviewMemory, currentReviewMemoryPrompt, removePullRequest };
}

const defaultStore = createStateStore();

export async function readState(): Promise<AppState> {
  return defaultStore.readState();
}

export async function currentReviewMemoryDistillationSource(): Promise<string> {
  return defaultStore.currentReviewMemoryDistillationSource();
}

export async function currentReviewMemoryContext(): Promise<string> {
  return defaultStore.currentReviewMemoryContext();
}

export async function currentReviewProfile(): Promise<ReviewMemoryProfile | null> {
  return defaultStore.currentReviewProfile();
}

export async function listReviewMemoryRecords(limit = 50): Promise<ReviewMemoryRecord[]> {
  return defaultStore.listReviewMemoryRecords(limit);
}

export async function reviewMemoryStats(): Promise<{ recordCount: number; inlineCommentCount: number; prCount: number; latestCreatedAt: string | null; profileUpdatedAt: string | null; profileSourceRecordCount: number | null }> {
  return defaultStore.reviewMemoryStats();
}

export async function saveReviewProfile(text: string): Promise<ReviewMemoryProfile> {
  return defaultStore.saveReviewProfile(text);
}

export async function listRecentPullRequests(): Promise<StoredPullRequest[]> {
  return defaultStore.listRecentPullRequests();
}

export async function upsertPullRequest(pr: StoredPullRequest): Promise<StoredPullRequest> {
  return defaultStore.upsertPullRequest(pr);
}

export async function markPullRequestReviewed(prKey: string, headSha: string, event: StoredPullRequest["lastReviewEvent"]): Promise<StoredPullRequest | null> {
  return defaultStore.markPullRequestReviewed(prKey, headSha, event);
}

export async function listFileReviews(prKey: string): Promise<FileReviewState[]> {
  return defaultStore.listFileReviews(prKey);
}

export async function setFileViewed(review: FileReviewState): Promise<FileReviewState> {
  return defaultStore.setFileViewed(review);
}

export async function getDraftReview(prKey: string): Promise<DraftReview | null> {
  return defaultStore.getDraftReview(prKey);
}

export async function saveDraftReview(review: DraftReview): Promise<DraftReview> {
  return defaultStore.saveDraftReview(review);
}

export async function listFocusScans(prKey: string): Promise<FocusScanRecord[]> {
  return defaultStore.listFocusScans(prKey);
}

export async function saveFocusScan(scan: Omit<FocusScanRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<FocusScanRecord, "id" | "createdAt">>): Promise<FocusScanRecord> {
  return defaultStore.saveFocusScan(scan);
}

export async function listAiReviews(prKey: string): Promise<AiReviewRecord[]> {
  return defaultStore.listAiReviews(prKey);
}

export async function saveAiReview(review: Omit<AiReviewRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<AiReviewRecord, "id" | "createdAt">>): Promise<AiReviewRecord> {
  return defaultStore.saveAiReview(review);
}

export async function saveReviewMemory(record: Omit<ReviewMemoryRecord, "id" | "createdAt">): Promise<ReviewMemoryRecord> {
  return defaultStore.saveReviewMemory(record);
}

export async function currentReviewMemoryPrompt(): Promise<string> {
  return defaultStore.currentReviewMemoryPrompt();
}

export async function removePullRequest(prKey: string): Promise<void> {
  return defaultStore.removePullRequest(prKey);
}
