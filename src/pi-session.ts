import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { logger } from "./logger.js";

type TextPart = {
  text?: string;
  type?: string;
};

type MessageLike = {
  content?: unknown;
  errorMessage?: string;
  role?: string;
  stopReason?: string;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

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
  setThinkingLevel?: (level: ThinkingLevel) => void;
  subscribe: (listener: (event: unknown) => void) => () => void;
  thinkingLevel?: ThinkingLevel;
};

const DEFAULT_PI_MODEL_PROVIDER = "openai-codex";
const DEFAULT_PI_MODEL_ID = "gpt-5.5";
const DEFAULT_PI_THINKING_LEVEL: ThinkingLevel = "high";
const PI_THINKING_LEVEL_BY_PURPOSE: Record<string, ThinkingLevel> = {
  "focus-chat": "medium",
  "inline-chat": "low",
};

const sessions = new Map<string, Promise<SessionRecord>>();
const cwdByPr = new Map<string, string>();
const lastPromptByPr = new Map<string, { chars: number; preview: string; startedAt: string }>();
const promptQueueByPr = new Map<string, Promise<void>>();
const promptStateByPr = new Map<string, { status: "queued" | "running" | "complete" | "failed"; purpose: string; chars: number; queuedAt: string; startedAt?: string; finishedAt?: string; answerChars?: number; error?: string }>();

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sessionKeyForPr(prKey: string, purpose = "chat"): string {
  return `${safe(prKey)}--${safe(purpose)}`;
}

function sessionDirForPr(prKey: string, purpose = "chat"): string {
  return resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "pi-sessions", sessionKeyForPr(prKey, purpose));
}

export async function registerPiSessionCwd(prKey: string, cwd: string): Promise<void> {
  const existingCwd = cwdByPr.get(prKey);
  cwdByPr.set(prKey, cwd);
  if (existingCwd != null && existingCwd !== cwd) {
    await disposePiSession(prKey);
  }
}

async function createSession(prKey: string, purpose = "chat"): Promise<SessionRecord> {
  const cwd = cwdByPr.get(prKey) ?? process.cwd();
  const sessionDir = sessionDirForPr(prKey, purpose);
  await mkdir(sessionDir, { recursive: true });
  const startedAt = performance.now();
  logger.info("pi", "create session", { prKey, purpose, cwd, sessionDir });
  const modelRegistry = ModelRegistry.create(AuthStorage.create());
  const model = modelRegistry.find(DEFAULT_PI_MODEL_PROVIDER, DEFAULT_PI_MODEL_ID);
  if (model == null) throw new Error(`Default Pi Review model not found: ${DEFAULT_PI_MODEL_PROVIDER}/${DEFAULT_PI_MODEL_ID}`);
  const thinkingLevel = PI_THINKING_LEVEL_BY_PURPOSE[purpose] ?? DEFAULT_PI_THINKING_LEVEL;
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRegistry,
    sessionManager: SessionManager.create(cwd, sessionDir),
    thinkingLevel,
  });
  logger.info("pi", "create session complete", { prKey, purpose, model: `${DEFAULT_PI_MODEL_PROVIDER}/${DEFAULT_PI_MODEL_ID}`, thinkingLevel, ms: Math.round(performance.now() - startedAt) });
  return session as SessionRecord;
}

function getSession(prKey: string, purpose = "chat"): Promise<SessionRecord> {
  const sessionKey = sessionKeyForPr(prKey, purpose);
  const existing = sessions.get(sessionKey);
  if (existing != null) return existing;
  const created = createSession(prKey, purpose);
  sessions.set(sessionKey, created);
  return created;
}

export function prewarmPiSession(prKey: string, purposes = ["chat"]): void {
  for (const purpose of purposes) {
    void getSession(prKey, purpose).catch((error: unknown) => logger.error("pi", "prewarm failed", { prKey, purpose, error: error instanceof Error ? error.message : String(error) }));
  }
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function modelLabel(model: SessionRecord["model"]): string | null {
  if (model == null) return null;
  if (model.provider != null && model.id != null) return `${model.provider}/${model.id}`;
  return model.id ?? ([model.provider, model.name].filter(Boolean).join("/") || null);
}

export async function piDiagnostics(prKey: string): Promise<Record<string, unknown>> {
  const session = await getSession(prKey);
  const prPrefix = `${safe(prKey)}--`;
  const sessionSummaries = await Promise.all([...sessions.entries()].filter(([key]) => key.startsWith(prPrefix)).map(async ([key, sessionPromise]) => {
    const purpose = key.slice(prPrefix.length);
    const state = promptStateByPr.get(key) ?? null;
    const settled = await Promise.race([sessionPromise.then((value) => ({ status: "ready" as const, value })), new Promise<{ status: "creating" }>((resolveCreating) => setTimeout(() => resolveCreating({ status: "creating" }), 0))]);
    return {
      purpose,
      ready: settled.status === "ready",
      sessionFile: settled.status === "ready" ? settled.value.sessionFile ?? null : null,
      sessionId: settled.status === "ready" ? settled.value.sessionId ?? null : null,
      isStreaming: settled.status === "ready" ? settled.value.isStreaming ?? null : null,
      activeTools: settled.status === "ready" ? settled.value.getActiveToolNames?.() ?? [] : [],
      lastPrompt: lastPromptByPr.get(key) ?? null,
      promptState: state == null ? null : { ...state, elapsedMs: Math.round(Date.parse(state.finishedAt ?? new Date().toISOString()) - Date.parse(state.startedAt ?? state.queuedAt)) },
      queued: promptQueueByPr.has(key),
    };
  }));
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
    lastPrompt: lastPromptByPr.get(sessionKeyForPr(prKey)) ?? null,
    sessions: sessionSummaries,
  };
}

export async function setPiModel(prKey: string, provider: string, modelId: string, thinkingLevel?: string): Promise<Record<string, unknown>> {
  const session = await getSession(prKey);
  const model = session.modelRegistry?.find?.(provider, modelId);
  if (model == null) throw new Error(`Unknown model ${provider}/${modelId}`);
  if (session.setModel == null) throw new Error("Pi session does not expose model switching");
  await session.setModel(model);
  if (thinkingLevel != null && thinkingLevel.length > 0) {
    if (!isThinkingLevel(thinkingLevel)) throw new Error(`Unknown thinking level ${thinkingLevel}`);
    session.setThinkingLevel?.(thinkingLevel);
  }
  return piDiagnostics(prKey);
}

export async function disposePiSession(prKey: string): Promise<void> {
  const sessionEntries = [...sessions.entries()].filter(([sessionKey]) => sessionKey.startsWith(`${safe(prKey)}--`));
  for (const [sessionKey] of sessionEntries) sessions.delete(sessionKey);
  cwdByPr.delete(prKey);
  for (const key of [...lastPromptByPr.keys()]) if (key.startsWith(`${safe(prKey)}--`)) lastPromptByPr.delete(key);
  for (const key of [...promptQueueByPr.keys()]) if (key.startsWith(`${safe(prKey)}--`)) promptQueueByPr.delete(key);
  for (const key of [...promptStateByPr.keys()]) if (key.startsWith(`${safe(prKey)}--`)) promptStateByPr.delete(key);
  for (const [, sessionPromise] of sessionEntries) {
    const session = await sessionPromise;
    await session.abort?.();
    session.dispose?.();
  }
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

function textFromMessage(message: unknown): string {
  if (typeof message !== "object" || message == null) return "";
  const { content, role } = message as MessageLike;
  if (role != null && role !== "assistant") return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part !== "object" || part == null) return "";
    const textPart = part as TextPart;
    return textPart.type === "text" && typeof textPart.text === "string" ? textPart.text : "";
  }).join("");
}

function messageFromEvent(event: unknown): unknown {
  if (typeof event !== "object" || event == null || !("type" in event)) return null;
  const typedEvent = event as { message?: unknown; type?: string };
  return typedEvent.type === "message_update" || typedEvent.type === "message_end" || typedEvent.type === "turn_end" ? typedEvent.message : null;
}

function errorFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message == null) return null;
  const { errorMessage, role, stopReason } = message as MessageLike;
  if (role !== "assistant" || stopReason !== "error") return null;
  return errorMessage ?? "Assistant stopped with an error.";
}

async function runPiPrompt(prKey: string, prompt: string, purpose = "chat", onDelta?: (delta: string) => void): Promise<string> {
  const startedAt = performance.now();
  const sessionKey = sessionKeyForPr(prKey, purpose);
  const session = await getSession(prKey, purpose);
  let answer = "";
  let latestAssistantText = "";
  let latestAssistantError: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    const message = messageFromEvent(event);
    const assistantText = textFromMessage(message);
    if (assistantText.trim().length > 0) latestAssistantText = assistantText;
    latestAssistantError = errorFromMessage(message) ?? latestAssistantError;
    const delta = textDeltaFromEvent(event);
    if (delta.length === 0) return;
    answer += delta;
    onDelta?.(delta);
  });
  lastPromptByPr.set(sessionKey, { chars: prompt.length, preview: prompt.slice(0, 1600), startedAt: new Date().toISOString() });
  logger.info("pi", "prompt start", { prKey, purpose, chars: prompt.length });
  try {
    await session.prompt(prompt);
    const finalAnswer = answer.trim() || latestAssistantText.trim();
    if (latestAssistantError != null) {
      logger.error("pi", "prompt model error", { prKey, purpose, ms: Math.round(performance.now() - startedAt), error: latestAssistantError });
      throw new Error(`Pi model error: ${latestAssistantError}`);
    }
    logger.info("pi", "prompt complete", { prKey, purpose, ms: Math.round(performance.now() - startedAt), answerChars: finalAnswer.length, streamedAnswerChars: answer.length });
    return finalAnswer || "Pi completed without assistant text.";
  } finally {
    unsubscribe();
  }
}

export async function askPi(prKey: string, prompt: string, purpose = "chat", onDelta?: (delta: string) => void): Promise<string> {
  const sessionKey = sessionKeyForPr(prKey, purpose);
  const previous = promptQueueByPr.get(sessionKey) ?? Promise.resolve();
  promptStateByPr.set(sessionKey, { status: "queued", purpose, chars: prompt.length, queuedAt: new Date().toISOString() });
  let releaseQueue: () => void = () => undefined;
  const queued = previous.catch(() => undefined).then(() => new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  }));
  promptQueueByPr.set(sessionKey, queued);
  await previous.catch(() => undefined);
  promptStateByPr.set(sessionKey, { status: "running", purpose, chars: prompt.length, queuedAt: promptStateByPr.get(sessionKey)?.queuedAt ?? new Date().toISOString(), startedAt: new Date().toISOString() });
  try {
    const answer = await runPiPrompt(prKey, prompt, purpose, onDelta);
    promptStateByPr.set(sessionKey, { ...promptStateByPr.get(sessionKey)!, status: "complete", finishedAt: new Date().toISOString(), answerChars: answer.length });
    return answer;
  } catch (error) {
    promptStateByPr.set(sessionKey, { ...promptStateByPr.get(sessionKey)!, status: "failed", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    releaseQueue();
    if (promptQueueByPr.get(sessionKey) === queued) promptQueueByPr.delete(sessionKey);
  }
}
