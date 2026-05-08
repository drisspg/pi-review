import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { logger } from "./logger.js";

type SessionRecord = {
  abort?: () => Promise<void>;
  dispose?: () => void;
  getActiveToolNames?: () => string[];
  getAllTools?: () => Array<{ name?: string; description?: string; source?: unknown }>;
  getAvailableThinkingLevels?: () => string[];
  isStreaming?: boolean;
  model?: { id?: string; name?: string; provider?: string };
  modelRegistry?: { find?: (provider: string, modelId: string) => unknown; getAvailable?: () => Array<{ id?: string; name?: string; provider?: string }> };
  prompt: (text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => Promise<void>;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: string) => void;
  subscribe: (listener: (event: unknown) => void) => () => void;
  thinkingLevel?: string;
};

const sessions = new Map<string, Promise<SessionRecord>>();
const cwdByPr = new Map<string, string>();
const lastPromptByPr = new Map<string, { chars: number; preview: string; startedAt: string }>();
const promptQueueByPr = new Map<string, Promise<void>>();

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sessionDirForPr(prKey: string): string {
  return resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "pi-sessions", safe(prKey));
}

export async function registerPiSessionCwd(prKey: string, cwd: string): Promise<void> {
  const existingCwd = cwdByPr.get(prKey);
  cwdByPr.set(prKey, cwd);
  if (existingCwd != null && existingCwd !== cwd) {
    await disposePiSession(prKey);
  }
}

async function createSession(prKey: string): Promise<SessionRecord> {
  const cwd = cwdByPr.get(prKey) ?? process.cwd();
  const sessionDir = sessionDirForPr(prKey);
  await mkdir(sessionDir, { recursive: true });
  logger.info("pi", "create session", { prKey, cwd, sessionDir });
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.continueRecent(cwd, sessionDir),
  });
  return session as SessionRecord;
}

function getSession(prKey: string): Promise<SessionRecord> {
  const existing = sessions.get(prKey);
  if (existing != null) return existing;
  const created = createSession(prKey);
  sessions.set(prKey, created);
  return created;
}

export function prewarmPiSession(prKey: string): void {
  void getSession(prKey).catch((error: unknown) => logger.error("pi", "prewarm failed", { prKey, error: error instanceof Error ? error.message : String(error) }));
}

function modelLabel(model: SessionRecord["model"]): string | null {
  if (model == null) return null;
  if (model.provider != null && model.id != null) return `${model.provider}/${model.id}`;
  return model.id ?? ([model.provider, model.name].filter(Boolean).join("/") || null);
}

export async function piDiagnostics(prKey: string): Promise<Record<string, unknown>> {
  const session = await getSession(prKey);
  return {
    prKey,
    cwd: cwdByPr.get(prKey) ?? process.cwd(),
    sessionDir: sessionDirForPr(prKey),
    sessionFile: session.sessionFile ?? null,
    sessionId: session.sessionId ?? null,
    sessionName: session.sessionName ?? null,
    model: modelLabel(session.model),
    thinkingLevel: session.thinkingLevel ?? null,
    availableModels: session.modelRegistry?.getAvailable?.().map((model) => ({ provider: model.provider, id: model.id, name: model.name })) ?? [],
    availableThinkingLevels: session.getAvailableThinkingLevels?.() ?? [],
    activeTools: session.getActiveToolNames?.() ?? [],
    tools: session.getAllTools?.().map((tool) => ({ name: tool.name, source: tool.source })).filter((tool) => tool.name != null) ?? [],
    lastPrompt: lastPromptByPr.get(prKey) ?? null,
  };
}

export async function setPiModel(prKey: string, provider: string, modelId: string, thinkingLevel?: string): Promise<Record<string, unknown>> {
  const session = await getSession(prKey);
  const model = session.modelRegistry?.find?.(provider, modelId);
  if (model == null) throw new Error(`Unknown model ${provider}/${modelId}`);
  if (session.setModel == null) throw new Error("Pi session does not expose model switching");
  await session.setModel(model);
  if (thinkingLevel != null && thinkingLevel.length > 0) session.setThinkingLevel?.(thinkingLevel);
  return piDiagnostics(prKey);
}

export async function disposePiSession(prKey: string): Promise<void> {
  const sessionPromise = sessions.get(prKey);
  sessions.delete(prKey);
  if (sessionPromise == null) return;
  const session = await sessionPromise;
  await session.abort?.();
  session.dispose?.();
}

export async function disposePiSessions(): Promise<void> {
  const settled = await Promise.allSettled([...sessions.values()]);
  sessions.clear();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    try {
      await result.value.abort?.();
      result.value.dispose?.();
    } catch (error) {
      logger.debug("pi", "dispose ignored failure", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function textDeltaFromEvent(event: unknown): string {
  if (typeof event !== "object" || event == null || !("type" in event) || event.type !== "message_update") return "";
  const update = event as { assistantMessageEvent?: { type?: string; delta?: string; text?: string } };
  if (update.assistantMessageEvent?.type !== "text_delta") return "";
  return update.assistantMessageEvent.delta ?? update.assistantMessageEvent.text ?? "";
}

async function runPiPrompt(prKey: string, prompt: string): Promise<string> {
  const startedAt = performance.now();
  const session = await getSession(prKey);
  let answer = "";
  const unsubscribe = session.subscribe((event) => {
    answer += textDeltaFromEvent(event);
  });
  lastPromptByPr.set(prKey, { chars: prompt.length, preview: prompt.slice(0, 1600), startedAt: new Date().toISOString() });
  logger.info("pi", "prompt start", { prKey, chars: prompt.length });
  try {
    await session.prompt(prompt);
    logger.info("pi", "prompt complete", { prKey, ms: Math.round(performance.now() - startedAt), answerChars: answer.length });
    return answer.trim() || "Pi completed without streamed text.";
  } finally {
    unsubscribe();
  }
}

export async function askPi(prKey: string, prompt: string): Promise<string> {
  const previous = promptQueueByPr.get(prKey) ?? Promise.resolve();
  let releaseQueue: () => void = () => undefined;
  const queued = previous.catch(() => undefined).then(() => new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  }));
  promptQueueByPr.set(prKey, queued);
  await previous.catch(() => undefined);
  try {
    return await runPiPrompt(prKey, prompt);
  } finally {
    releaseQueue();
    if (promptQueueByPr.get(prKey) === queued) promptQueueByPr.delete(prKey);
  }
}
