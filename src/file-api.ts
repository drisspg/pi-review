import { sep, resolve } from "node:path";

import { parsePullRequestRef } from "./pr.js";
import type { FileReviewState, PullRequestRef } from "./types.js";
import { worktreeDirForRef } from "./worktrees.js";

export type FileApiDeps = {
  fetchFileText: (ref: PullRequestRef, path: string, sha: string) => Promise<string>;
  now: () => string;
  openUrl: (url: string) => Promise<void>;
  parsePullRequestRef: (input: string) => PullRequestRef;
  setFileViewed: (review: FileReviewState) => Promise<FileReviewState>;
  worktreeDirForRef: (ref: PullRequestRef) => string;
};

export type FileApi = {
  viewed: (payload: Record<string, unknown>) => Promise<{ fileReview: FileReviewState }>;
  text: (payload: Record<string, unknown>) => Promise<{ text: string }>;
  open: (payload: Record<string, unknown>) => Promise<{ target: string }>;
};

export const defaultFileApiDeps = (fetchFileText: FileApiDeps["fetchFileText"], setFileViewed: FileApiDeps["setFileViewed"], openUrl: FileApiDeps["openUrl"]): FileApiDeps => ({
  fetchFileText,
  now: () => new Date().toISOString(),
  openUrl,
  parsePullRequestRef,
  setFileViewed,
  worktreeDirForRef,
});

function refFromPayload(payload: Record<string, unknown>, parse: (input: string) => PullRequestRef): PullRequestRef {
  if (typeof payload.prUrl !== "string") throw new Error("Expected prUrl");
  return parse(payload.prUrl);
}

function viewedReviewFromPayload(payload: Record<string, unknown>, updatedAt: string): FileReviewState {
  if (typeof payload.prKey !== "string" || typeof payload.path !== "string" || typeof payload.fingerprint !== "string" || typeof payload.viewed !== "boolean") throw new Error("Expected file viewed payload");
  return { prKey: payload.prKey, path: payload.path, fingerprint: payload.fingerprint, viewed: payload.viewed, updatedAt };
}

function editorUrlForTarget(target: string): string {
  return `vscode://file${encodeURI(target).replace(/[?#]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function editorTarget(worktreeDir: string, path: string, line?: number): string {
  const filePath = resolve(worktreeDir, path);
  if (filePath !== worktreeDir && !filePath.startsWith(`${worktreeDir}${sep}`)) throw new Error("File path escapes PR worktree");
  return `${filePath}:${line ?? 1}:1`;
}

export function createFileApi(deps: FileApiDeps): FileApi {
  async function viewed(payload: Record<string, unknown>): Promise<{ fileReview: FileReviewState }> {
    return { fileReview: await deps.setFileViewed(viewedReviewFromPayload(payload, deps.now())) };
  }

  async function text(payload: Record<string, unknown>): Promise<{ text: string }> {
    const ref = refFromPayload(payload, deps.parsePullRequestRef);
    if (typeof payload.path !== "string" || typeof payload.sha !== "string") throw new Error("Expected path and sha");
    return { text: await deps.fetchFileText(ref, payload.path, payload.sha) };
  }

  async function open(payload: Record<string, unknown>): Promise<{ target: string }> {
    if (typeof payload.prUrl !== "string" || typeof payload.path !== "string") throw new Error("Expected prUrl and path");
    const target = editorTarget(deps.worktreeDirForRef(deps.parsePullRequestRef(payload.prUrl)), payload.path, typeof payload.line === "number" ? payload.line : undefined);
    await deps.openUrl(editorUrlForTarget(target));
    return { target };
  }

  return { viewed, text, open };
}
