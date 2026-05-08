import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { logger } from "./logger.js";
import { prKey } from "./pr.js";
import { listFileReviews } from "./state.js";
import type { PullFile, PullRequest, PullRequestRef, PullRequestReviewData, PullReviewComment, StoredPullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

async function ghApi<T>(path: string): Promise<T> {
  const startedAt = performance.now();
  logger.info("github", "gh api start", { path });
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["api", path], { maxBuffer: 50 * 1024 * 1024 });
    logger.info("github", "gh api complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
    return JSON.parse(stdout) as T;
  } catch (error) {
    logger.error("github", "gh api failed", { path, ms: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function apiBase(ref: PullRequestRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

function toStoredPullRequest(ref: PullRequestRef, pr: PullRequest, files: PullFile[], comments: PullReviewComment[]): StoredPullRequest {
  return {
    key: prKey(ref),
    ref,
    url: pr.html_url,
    title: pr.title,
    state: pr.state,
    author: pr.user?.login ?? null,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    filesChanged: files.length,
    existingCommentCount: comments.length,
    lastOpenedAt: new Date().toISOString(),
    lastReviewedHeadSha: null,
  };
}

function fileFingerprint(file: PullFile): string {
  return createHash("sha1").update(`${file.status}\n${file.previous_filename ?? ""}\n${file.patch ?? ""}`).digest("hex");
}

export async function fetchPullRequestReviewData(ref: PullRequestRef): Promise<PullRequestReviewData> {
  logger.info("github", "fetch PR review data", { ref });
  const [rawPr, files, comments] = await Promise.all([
    ghApi<PullRequest>(apiBase(ref)),
    ghApi<PullFile[]>(`${apiBase(ref)}/files`),
    ghApi<PullReviewComment[]>(`${apiBase(ref)}/comments`),
  ]);
  const pr = toStoredPullRequest(ref, rawPr, files, comments);
  logger.info("github", "fetched PR review data", { key: pr.key, title: pr.title, files: files.length, comments: comments.length });
  const storedFileReviews = await listFileReviews(pr.key);
  const fileReviews = files.map((file) => {
    const fingerprint = fileFingerprint(file);
    return storedFileReviews.find((review) => review.path === file.filename && review.fingerprint === fingerprint) ?? {
      prKey: pr.key,
      path: file.filename,
      fingerprint,
      viewed: false,
      updatedAt: new Date().toISOString(),
    };
  });
  return { pr, files, comments, fileReviews };
}

export function fingerprintPullFile(file: PullFile): string {
  return fileFingerprint(file);
}

export async function fetchFileText(ref: PullRequestRef, path: string, sha: string): Promise<string> {
  const endpoint = `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${sha}`;
  const startedAt = performance.now();
  logger.info("github", "fetch file text start", { path, sha: sha.slice(0, 12) });
  const { stdout } = await execFileAsync("gh", ["api", endpoint, "-H", "Accept: application/vnd.github.raw"], { maxBuffer: 50 * 1024 * 1024 });
  logger.info("github", "fetch file text complete", { path, ms: Math.round(performance.now() - startedAt), bytes: stdout.length });
  return stdout.replace(/\r\n/g, "\n");
}

export async function submitPullRequestReview(ref: PullRequestRef, payload: unknown): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-"));
  const inputPath = join(dir, "review.json");
  await writeFile(inputPath, JSON.stringify(payload), "utf8");
  const startedAt = performance.now();
  logger.info("github", "submit review start", { ref });
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["api", apiBase(ref) + "/reviews", "--method", "POST", "--input", inputPath], { maxBuffer: 50 * 1024 * 1024 });
    logger.info("github", "submit review complete", { ref, ms: Math.round(performance.now() - startedAt), bytes: stdout.length, stderr: stderr.trim() || undefined });
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    logger.error("github", "submit review failed", { ref, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function fetchPullRequestSummary(ref: PullRequestRef): Promise<StoredPullRequest> {
  return (await fetchPullRequestReviewData(ref)).pr;
}
