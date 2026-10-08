import { formatPreReviewEvidence } from "./pre-review-assessor.js";
import type { PytorchPreReviewAssessment, PytorchPreReviewEvidence } from "./types.js";

/**
 * Inline chat about a queued PyTorch PR: ask about the saved pre-review suggestion or do a
 * quick high-level review. Each turn is a fresh tool-less model run over read-only evidence
 * (description, conversation, linked issue, size-capped diff), the saved assessment, and the
 * thread so far; no checkout, no GitHub writes. Threads persist per PR.
 */
export type ChatTurn = { role: "user" | "assistant"; text: string; at: string };

export type PreReviewChatDeps = {
  gatherEvidence: (number: number) => Promise<PytorchPreReviewEvidence>;
  runModel: (prompt: string, signal: AbortSignal) => Promise<string>;
  readAssessment: (number: number) => Promise<PytorchPreReviewAssessment | null>;
  readThread: (number: number) => Promise<ChatTurn[]>;
  writeThread: (number: number, turns: ChatTurn[]) => Promise<void>;
  now: () => string;
  /** Reuse fetched evidence this long, so a back-and-forth costs one GitHub read. */
  evidenceTtlMs?: number;
};

export type PreReviewChat = {
  ask: (payload: Record<string, unknown>) => Promise<{ number: number; answer: string; thread: ChatTurn[] }>;
  thread: (payload: Record<string, unknown>) => Promise<{ number: number; thread: ChatTurn[] }>;
  clear: (payload: Record<string, unknown>) => Promise<{ number: number; thread: ChatTurn[] }>;
  /** Abort in-flight turns (server shutdown). */
  stop: () => void;
};

const MAX_HISTORY_TURNS = 12;
const MAX_QUESTION_CHARS = 4000;

function requiredNumber(payload: Record<string, unknown>): number {
  const value = payload.number;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error("Expected a positive integer number");
  return value;
}

export function preReviewChatPrompt(evidence: PytorchPreReviewEvidence, assessment: PytorchPreReviewAssessment | null, history: ChatTurn[], question: string): string {
  const verdict = assessment == null
    ? "No saved pre-review suggestion yet."
    : `${assessment.source} recommended: ${assessment.recommendation === "draft" ? "Back to draft" : assessment.recommendation === "accept" ? "Accept" : "Close"}
Why: ${assessment.why}
Pre-conditions: ${assessment.preconditions ?? "not stated"}
Notes:
${assessment.notes.map((note) => `- ${note}`).join("\n") || "- none"}${assessment.comment == null ? "" : `\nSuggested author comment:\n${assessment.comment}`}`;
  const thread = history.slice(-MAX_HISTORY_TURNS).map((turn) => `${turn.role === "user" ? "Maintainer" : "You"}: ${turn.text}`).join("\n\n");
  return `You are helping a PyTorch maintainer with PR #${evidence.number} "${evidence.title}" under PyTorch's pre-review workflow (a quick direction check: clear description, important problem, sound approach, reviewable size; descriptions often lag the code, which is a full-review note rather than a blocker).

Answer the maintainer's latest message conversationally and concisely. You may explain or defend the saved suggestion, change your mind when the maintainer raises something real, or give a quick high-level review of the diff when asked. You have no tools: rely only on the evidence below, cite it, and say plainly when something cannot be determined from it. Stay high level; this is not a line-by-line review.

If, and only if, your recommendation changes or the maintainer asks you to re-assess, end with:
Recommendation: Accept | Back to draft | Close
Why (one line): <single sentence>
and, when not Accept, a \`\`\`comment block for the author.

# Saved pre-review suggestion
${verdict}

# Evidence (read-only GitHub snapshot)
${formatPreReviewEvidence(evidence)}

# Conversation so far
${thread || "(this is the first message)"}

Maintainer: ${question}`;
}

export function createPreReviewChat(deps: PreReviewChatDeps): PreReviewChat {
  const evidenceTtlMs = deps.evidenceTtlMs ?? 10 * 60 * 1000;
  const evidenceCache = new Map<number, { at: number; evidence: PytorchPreReviewEvidence }>();
  const inFlight = new Map<number, AbortController>();

  async function evidenceFor(number: number): Promise<PytorchPreReviewEvidence> {
    const cached = evidenceCache.get(number);
    const nowMs = Date.parse(deps.now());
    if (cached != null && nowMs - cached.at < evidenceTtlMs) return cached.evidence;
    const evidence = await deps.gatherEvidence(number);
    evidenceCache.set(number, { at: nowMs, evidence });
    return evidence;
  }

  return {
    async ask(payload) {
      const number = requiredNumber(payload);
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      if (question.length === 0) throw new Error("Expected a question");
      if (question.length > MAX_QUESTION_CHARS) throw new Error(`Keep questions under ${MAX_QUESTION_CHARS} characters`);
      if (inFlight.has(number)) throw new Error(`Already answering a question about #${number}`);
      const controller = new AbortController();
      inFlight.set(number, controller);
      try {
        const [evidence, assessment, history] = await Promise.all([evidenceFor(number), deps.readAssessment(number), deps.readThread(number)]);
        const asked: ChatTurn = { role: "user", text: question, at: deps.now() };
        const answer = (await deps.runModel(preReviewChatPrompt(evidence, assessment, history, question), controller.signal)).trim();
        const thread = [...history, asked, { role: "assistant" as const, text: answer, at: deps.now() }];
        await deps.writeThread(number, thread);
        return { number, answer, thread };
      } finally {
        inFlight.delete(number);
      }
    },
    async thread(payload) {
      const number = requiredNumber(payload);
      return { number, thread: await deps.readThread(number) };
    },
    async clear(payload) {
      const number = requiredNumber(payload);
      await deps.writeThread(number, []);
      return { number, thread: [] };
    },
    stop() {
      for (const controller of inFlight.values()) controller.abort();
    },
  };
}
