import type { PytorchAssessorStatus, PytorchEvidenceComment, PytorchPreReviewEvidence } from "./types.js";

/**
 * One background agent that walks the viewer's owed PyTorch pre-reviews, top of the queue first,
 * and saves an advisory suggestion for each. It never acts on GitHub: evidence is gathered with
 * read-only calls and the model runs without tools, so the maintainer still makes every decision.
 */
export type PreReviewAssessorDeps = {
  enabled: boolean;
  /** Label stored on each suggestion, e.g. "Astra". */
  source: string;
  listCandidates: () => Promise<Array<{ number: number; updatedAt: string }>>;
  gatherEvidence: (number: number) => Promise<PytorchPreReviewEvidence>;
  buildPrompt: (evidence: PytorchPreReviewEvidence) => Promise<string>;
  runModel: (prompt: string, signal: AbortSignal) => Promise<string>;
  save: (input: { number: number; markdown: string; prUpdatedAt: string; source: string }) => Promise<void>;
  now: () => string;
  setTimer?: (callback: () => void, ms: number) => () => void;
  logger?: { info: (scope: string, message: string, data?: Record<string, unknown>) => void; warn: (scope: string, message: string, data?: Record<string, unknown>) => void };
  /** Recheck cadence once caught up. */
  idleMs?: number;
  /** Pause between assessments, keeping GitHub and model traffic gentle. */
  betweenMs?: number;
  /** A PR whose assessment failed is skipped this long before retrying. */
  retryAfterMs?: number;
};

export type PreReviewAssessor = {
  start: () => void;
  /** Wake an idle loop, e.g. after the queue snapshot refreshed. */
  poke: () => void;
  /** Explicit request (e.g. the PR page button): queued behind any in-flight run; works even when the background loop is off. */
  assessNow: (number: number) => Promise<void>;
  status: () => PytorchAssessorStatus;
  /** Abort the in-flight model run and wait for the loop to settle. */
  stop: () => Promise<void>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Diff budget: enough to see the shape of the change without turning pre-review into a code review. */
const DIFF_FILE_CHARS = 3000;
const DIFF_TOTAL_CHARS = 30000;

function formatDiff(files: PytorchPreReviewEvidence["files"]): string {
  let budget = DIFF_TOTAL_CHARS;
  const parts: string[] = [];
  let omitted = 0;
  for (const file of files) {
    if (file.patch == null || file.patch.length === 0) continue;
    if (budget <= 0) {
      omitted += 1;
      continue;
    }
    const patchText = file.patch.length > Math.min(DIFF_FILE_CHARS, budget) ? `${file.patch.slice(0, Math.min(DIFF_FILE_CHARS, budget))}\n... (truncated)` : file.patch;
    budget -= patchText.length;
    parts.push(`### ${file.path}\n\`\`\`diff\n${patchText}\n\`\`\``);
  }
  if (omitted > 0) parts.push(`(${omitted} more file diffs omitted for length)`);
  return parts.length === 0 ? "(no textual diff available)" : parts.join("\n\n");
}

function formatComments(comments: PytorchEvidenceComment[]): string {
  if (comments.length === 0) return "(none)";
  return comments.map((comment) => `- ${comment.author ?? "unknown"}${comment.state != null ? ` [${comment.state}]` : ""} ${comment.at.slice(0, 10)}: ${comment.body.replace(/\s+/g, " ") || "(no text)"}`).join("\n");
}

/** Render gathered evidence as plain Markdown for a tool-less model. */
export function formatPreReviewEvidence(evidence: PytorchPreReviewEvidence): string {
  const issues = evidence.linkedIssues.length === 0 ? "No closing issue references." : evidence.linkedIssues.map((issue) => `### #${issue.number} ${issue.title} (${issue.state}; labels: ${issue.labels.join(", ") || "none"})\n${issue.body || "(no body)"}\n\nRecent comments:\n${formatComments(issue.comments)}`).join("\n\n");
  const files = evidence.files.map((file) => `- ${file.path} (+${file.additions}/-${file.deletions})`).join("\n");
  return `Author: ${evidence.author ?? "unknown"} (repo permission: ${evidence.authorPermission ?? "unknown"})
Opened ${evidence.createdAt.slice(0, 10)}, last updated ${evidence.updatedAt.slice(0, 10)}; +${evidence.additions}/-${evidence.deletions} in ${evidence.changedFiles} files.
Labels: ${evidence.labels.join(", ") || "none"}

## Changed files${evidence.files.length < evidence.changedFiles ? ` (first ${evidence.files.length})` : ""}
${files || "(none listed)"}

## Reviews (latest last)
${formatComments(evidence.reviews)}

## PR conversation (latest last)
${formatComments(evidence.comments)}

## Linked issues
${issues}

## Diff (size-capped; read for the shape of the change, not line by line)
${formatDiff(evidence.files)}`;
}

export function createPreReviewAssessor(deps: PreReviewAssessorDeps): PreReviewAssessor {
  const idleMs = deps.idleMs ?? 2 * 60 * 1000;
  const betweenMs = deps.betweenMs ?? 5 * 1000;
  const retryAfterMs = deps.retryAfterMs ?? 30 * 60 * 1000;
  const setTimer = deps.setTimer ?? ((callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  });
  const failedUntil = new Map<number, number>();
  let cancelTimer: (() => void) | null = null;
  // Background ticks and explicit requests share one lane, so at most one model run is ever in flight.
  let lane: Promise<unknown> = Promise.resolve();
  let ticking = false;
  let controller: AbortController | null = null;
  let stopped = !deps.enabled;
  let shuttingDown = false;
  let current: PytorchAssessorStatus["current"] = null;
  let pending = 0;
  let completed = 0;
  let lastError: PytorchAssessorStatus["lastError"] = null;

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = lane.then(work, work);
    lane = run.catch(() => undefined);
    return run;
  }

  function schedule(ms: number): void {
    cancelTimer?.();
    cancelTimer = stopped ? null : setTimer(() => {
      cancelTimer = null;
      void tick();
    }, ms);
  }

  async function assessOne(number: number): Promise<void> {
    if (shuttingDown) throw new Error("Pre-review assessor is shutting down");
    current = { number, startedAt: deps.now() };
    controller = new AbortController();
    try {
      const evidence = await deps.gatherEvidence(number);
      const markdown = await deps.runModel(await deps.buildPrompt(evidence), controller.signal);
      if (shuttingDown) throw new Error("Pre-review assessor is shutting down");
      await deps.save({ number, markdown, prUpdatedAt: evidence.updatedAt, source: deps.source });
      completed += 1;
      failedUntil.delete(number);
      deps.logger?.info("pre-review-assessor", "assessed", { number });
    } catch (error) {
      if (!shuttingDown) {
        failedUntil.set(number, Date.parse(deps.now()) + retryAfterMs);
        lastError = { number, message: errorText(error).slice(0, 300), at: deps.now() };
        deps.logger?.warn("pre-review-assessor", "assessment failed", { number, error: lastError.message });
      }
      throw error;
    } finally {
      current = null;
      controller = null;
    }
  }

  async function step(): Promise<number> {
    const nowMs = Date.parse(deps.now());
    const candidates = (await deps.listCandidates()).filter((candidate) => (failedUntil.get(candidate.number) ?? 0) <= nowMs);
    pending = candidates.length;
    const next = candidates[0];
    if (next == null || stopped) return idleMs;
    await assessOne(next.number).then(() => { pending = Math.max(0, pending - 1); }, () => undefined);
    return betweenMs;
  }

  function tick(): void {
    if (stopped || ticking) return;
    ticking = true;
    void serialize(step).catch((error: unknown) => {
      deps.logger?.warn("pre-review-assessor", "candidate listing failed", { error: errorText(error) });
      return idleMs;
    }).then((delay) => {
      ticking = false;
      schedule(delay);
    });
  }

  return {
    start() {
      if (!deps.enabled) return;
      stopped = false;
      schedule(0);
    },
    poke() {
      if (!stopped && !ticking) schedule(0);
    },
    assessNow(number) {
      return serialize(() => assessOne(number));
    },
    status() {
      return { enabled: deps.enabled && !stopped, source: deps.source, current, pending, completed, lastError };
    },
    async stop() {
      stopped = true;
      shuttingDown = true;
      cancelTimer?.();
      cancelTimer = null;
      controller?.abort();
      await lane;
    },
  };
}
