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
  status: () => PytorchAssessorStatus;
  /** Abort the in-flight model run and wait for the loop to settle. */
  stop: () => Promise<void>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
${issues}`;
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
  let loop: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let stopped = !deps.enabled;
  let current: PytorchAssessorStatus["current"] = null;
  let pending = 0;
  let completed = 0;
  let lastError: PytorchAssessorStatus["lastError"] = null;

  function schedule(ms: number): void {
    cancelTimer?.();
    cancelTimer = stopped ? null : setTimer(() => {
      cancelTimer = null;
      void tick();
    }, ms);
  }

  async function step(): Promise<number> {
    const nowMs = Date.parse(deps.now());
    const candidates = (await deps.listCandidates()).filter((candidate) => (failedUntil.get(candidate.number) ?? 0) <= nowMs);
    pending = candidates.length;
    const next = candidates[0];
    if (next == null) return idleMs;
    current = { number: next.number, startedAt: deps.now() };
    controller = new AbortController();
    try {
      const evidence = await deps.gatherEvidence(next.number);
      const markdown = await deps.runModel(await deps.buildPrompt(evidence), controller.signal);
      if (stopped) return idleMs;
      await deps.save({ number: next.number, markdown, prUpdatedAt: evidence.updatedAt, source: deps.source });
      completed += 1;
      pending = Math.max(0, pending - 1);
      failedUntil.delete(next.number);
      deps.logger?.info("pre-review-assessor", "assessed", { number: next.number, pending });
    } catch (error) {
      if (stopped) return idleMs;
      failedUntil.set(next.number, Date.parse(deps.now()) + retryAfterMs);
      lastError = { number: next.number, message: errorText(error).slice(0, 300), at: deps.now() };
      deps.logger?.warn("pre-review-assessor", "assessment failed", { number: next.number, error: lastError.message });
    } finally {
      current = null;
      controller = null;
    }
    return betweenMs;
  }

  function tick(): Promise<void> {
    if (stopped || loop != null) return loop ?? Promise.resolve();
    loop = step().catch((error: unknown) => {
      deps.logger?.warn("pre-review-assessor", "candidate listing failed", { error: errorText(error) });
      return idleMs;
    }).then((delay) => schedule(delay)).finally(() => {
      loop = null;
    });
    return loop;
  }

  return {
    start() {
      if (!deps.enabled) return;
      stopped = false;
      schedule(0);
    },
    poke() {
      if (!stopped && loop == null) schedule(0);
    },
    status() {
      return { enabled: deps.enabled && !stopped, source: deps.source, current, pending, completed, lastError };
    },
    async stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      controller?.abort();
      await loop;
    },
  };
}
