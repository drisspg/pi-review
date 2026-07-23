import { AuthStorage, createAgentSession, type AgentSession, type AgentSessionEvent, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { createGpuWorkspaceTool } from "./gpu-workspace-tool.js";
import { logger } from "./logger.js";
import { createReviewDraftTool, type ReviewDraftToolContext } from "./review-draft-tool.js";
import type { PiPromptEvent } from "./types.js";

export type { PiPromptEvent } from "./types.js";

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

type ThinkingLevel = AgentSession["thinkingLevel"];

const DEFAULT_PI_MODEL_PROVIDER = "openai-codex";
const DEFAULT_PI_MODEL_ID = "gpt-5.6-sol";
const DEFAULT_PI_THINKING_LEVEL: ThinkingLevel = "high";
const PI_THINKING_LEVEL_BY_PURPOSE: Record<string, ThinkingLevel> = {
  "chat": "medium",
  "flow-dag": "medium",
  "focus-chat": "medium",
  "focus-review": "medium",
  "gpu-workspace": "medium",
  "inline-chat": "low",
  "main-review": "medium",
  "review-memory-distill": "low",
  "test-pr": "medium",
};

const REVIEW_TOOLS = ["read", "grep", "find", "bash"];
const CHAT_TOOLS = ["read", "grep", "find", "bash", "web_search"];
const INLINE_TOOLS = ["read", "grep", "find", "web_search"];
const DRAFT_TOOL_PURPOSES = new Set(["chat", "inline-chat", "focus-chat"]);

const PI_TOOLS_BY_PURPOSE: Record<string, string[]> = {
  "chat": CHAT_TOOLS,
  "flow-dag": REVIEW_TOOLS,
  "focus-chat": CHAT_TOOLS,
  "focus-review": REVIEW_TOOLS,
  "inline-chat": INLINE_TOOLS,
  "main-review": REVIEW_TOOLS,
  "review-memory-distill": CHAT_TOOLS,
  "test-pr": REVIEW_TOOLS,
};

const sessions = new Map<string, Promise<AgentSession>>();
const cwdByPr = new Map<string, string>();
const reviewContextByPr = new Map<string, ReviewDraftToolContext>();
const lastPromptByPr = new Map<string, { chars: number; preview: string; startedAt: string }>();
const promptQueueByPr = new Map<string, Promise<void>>();
type PromptState = { status: "queued" | "running" | "complete" | "failed"; purpose: string; chars: number; queuedAt: string; startedAt?: string; finishedAt?: string; answerChars?: number; error?: string; lastActivityAt?: string; detail?: string };

export type PiActivity = {
  purpose: string;
  status: "queued" | "running" | "complete" | "failed" | "idle";
  label: string;
  elapsedMs: number;
  idleMs: number | null;
  chars: number;
  answerChars: number;
  activeTools: string[];
  isStreaming: boolean | null;
  queued: boolean;
  startedAt?: string;
  lastActivityAt?: string;
  error?: string;
  detail?: string;
};

const promptStateByPr = new Map<string, PromptState>();

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function sessionPrefixForPr(prKey: string): string {
  return `${safe(prKey)}--`;
}

function sessionKeyForPr(prKey: string, purpose = "chat"): string {
  return `${sessionPrefixForPr(prKey)}${safe(purpose)}`;
}

function sessionEntriesForPr(prKey: string): Array<[string, Promise<AgentSession>]> {
  const prefix = sessionPrefixForPr(prKey);
  return [...sessions.entries()].filter(([key]) => key.startsWith(prefix));
}

async function settledSession(sessionPromise: Promise<AgentSession> | undefined): Promise<AgentSession | null> {
  if (sessionPromise == null) return null;
  return Promise.race([sessionPromise, new Promise<null>((resolveCreating) => setTimeout(() => resolveCreating(null), 0))]);
}

function deleteEntriesWithPrefix<T>(map: Map<string, T>, prefix: string): void {
  for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
}

function sessionDirForPr(prKey: string, purpose = "chat"): string {
  return resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "pi-sessions", sessionKeyForPr(prKey, purpose));
}

/** Register the checkout and current diff used by PR-scoped conversational tools. */
export async function registerPiSessionContext(prKey: string, cwd: string, context: ReviewDraftToolContext): Promise<void> {
  const existingCwd = cwdByPr.get(prKey);
  const existingContext = reviewContextByPr.get(prKey);
  if (existingCwd != null && (existingCwd !== cwd || existingContext?.headSha !== context.headSha)) await disposePiSession(prKey);
  cwdByPr.set(prKey, cwd);
  reviewContextByPr.set(prKey, context);
}

let sharedModelRegistry: ReturnType<typeof ModelRegistry.create> | null = null;

function getModelRegistry(): ReturnType<typeof ModelRegistry.create> {
  sharedModelRegistry ??= ModelRegistry.create(AuthStorage.create());
  return sharedModelRegistry;
}

async function createSession(prKey: string, purpose = "chat"): Promise<AgentSession> {
  const cwd = cwdByPr.get(prKey) ?? process.cwd();
  const sessionDir = sessionDirForPr(prKey, purpose);
  await mkdir(sessionDir, { recursive: true });
  const startedAt = performance.now();
  logger.info("pi", "create session", { prKey, purpose, cwd, sessionDir });
  const modelRegistry = getModelRegistry();
  const model = modelRegistry.find(DEFAULT_PI_MODEL_PROVIDER, DEFAULT_PI_MODEL_ID);
  if (model == null) throw new Error(`Default Pi Review model not found: ${DEFAULT_PI_MODEL_PROVIDER}/${DEFAULT_PI_MODEL_ID}`);
  const thinkingLevel = PI_THINKING_LEVEL_BY_PURPOSE[purpose] ?? DEFAULT_PI_THINKING_LEVEL;
  const scopedTools = PI_TOOLS_BY_PURPOSE[purpose];
  const reviewContext = reviewContextByPr.get(prKey);
  const draftTool = reviewContext == null || !DRAFT_TOOL_PURPOSES.has(purpose) ? null : createReviewDraftTool(prKey, reviewContext);
  const customTools = draftTool == null ? [] : [draftTool];
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRegistry,
    sessionManager: SessionManager.create(cwd, sessionDir),
    thinkingLevel,
    ...(scopedTools == null
      ? { customTools: [createGpuWorkspaceTool(prKey), ...customTools] }
      : { tools: [...scopedTools, ...(draftTool == null ? [] : ["draft_review_comment"])], customTools }),
  });
  logger.info("pi", "create session complete", { prKey, purpose, model: `${DEFAULT_PI_MODEL_PROVIDER}/${DEFAULT_PI_MODEL_ID}`, thinkingLevel, ms: Math.round(performance.now() - startedAt) });
  return session;
}

function getSession(prKey: string, purpose = "chat"): Promise<AgentSession> {
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

function modelLabel(model: AgentSession["model"]): string | null {
  if (model == null) return null;
  if (model.provider != null && model.id != null) return `${model.provider}/${model.id}`;
  return model.id ?? ([model.provider, model.name].filter(Boolean).join("/") || null);
}

function elapsedMsSince(iso: string | undefined, now = Date.now()): number {
  if (iso == null) return 0;
  const then = Date.parse(iso);
  return Number.isFinite(then) ? Math.max(0, now - then) : 0;
}

function activityLabel(state: PromptState | null, activeTools: string[], isStreaming: boolean | null): string {
  if (state == null) return "idle";
  if (state.status === "queued") return "queued";
  if (state.status === "failed") return "failed";
  if (state.status === "complete") return "complete";
  if (activeTools.length > 0) return `using ${activeTools.join(", ")}`;
  if (isStreaming === true) return "streaming response";
  return "thinking";
}

export async function piActivity(prKey: string, purpose = "chat"): Promise<PiActivity> {
  const key = sessionKeyForPr(prKey, purpose);
  const state = promptStateByPr.get(key) ?? null;
  const session = await settledSession(sessions.get(key));
  const activeTools = session?.getActiveToolNames() ?? [];
  const isStreaming = session?.isStreaming ?? null;
  const now = Date.now();
  const startedAt = state?.startedAt ?? state?.queuedAt;
  const lastActivityAt = state?.lastActivityAt ?? startedAt;
  return {
    purpose,
    status: state?.status ?? "idle",
    label: activityLabel(state, activeTools, isStreaming),
    elapsedMs: elapsedMsSince(startedAt, now),
    idleMs: state?.status === "running" || state?.status === "queued" ? elapsedMsSince(lastActivityAt, now) : null,
    chars: state?.chars ?? 0,
    answerChars: state?.answerChars ?? 0,
    activeTools,
    isStreaming,
    queued: promptQueueByPr.has(key) || state?.status === "queued",
    startedAt,
    lastActivityAt,
    error: state?.error,
    detail: state?.status === "running" ? state?.detail : undefined,
  };
}

export async function piDiagnostics(prKey: string): Promise<Record<string, unknown>> {
  const session = await getSession(prKey);
  const prPrefix = sessionPrefixForPr(prKey);
  const sessionSummaries = await Promise.all(sessionEntriesForPr(prKey).map(async ([key, sessionPromise]) => {
    const purpose = key.slice(prPrefix.length);
    const state = promptStateByPr.get(key) ?? null;
    const readySession = await settledSession(sessionPromise);
    return {
      purpose,
      ready: readySession != null,
      sessionFile: readySession?.sessionFile ?? null,
      sessionId: readySession?.sessionId ?? null,
      isStreaming: readySession?.isStreaming ?? null,
      activeTools: readySession?.getActiveToolNames() ?? [],
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
    availableModels: session.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    activeTools: session.getActiveToolNames(),
    tools: session.getAllTools().map(({ name, sourceInfo }) => ({ name, source: sourceInfo })),
    lastPrompt: lastPromptByPr.get(sessionKeyForPr(prKey)) ?? null,
    sessions: sessionSummaries,
  };
}

export async function setPiModel(prKey: string, provider: string, modelId: string, thinkingLevel?: string): Promise<Record<string, unknown>> {
  const model = getModelRegistry().find(provider, modelId);
  if (model == null) throw new Error(`Unknown model ${provider}/${modelId}`);
  if (thinkingLevel != null && thinkingLevel.length > 0 && !isThinkingLevel(thinkingLevel)) throw new Error(`Unknown thinking level ${thinkingLevel}`);
  const prSessions = await Promise.all(sessionEntriesForPr(prKey).map(([, sessionPromise]) => sessionPromise));
  if (prSessions.length === 0) prSessions.push(await getSession(prKey));
  for (const session of prSessions) {
    await session.setModel(model);
    if (thinkingLevel != null && thinkingLevel.length > 0) session.setThinkingLevel(thinkingLevel as ThinkingLevel);
  }
  return piDiagnostics(prKey);
}

export async function disposePiSession(prKey: string): Promise<void> {
  const prefix = sessionPrefixForPr(prKey);
  const sessionEntries = sessionEntriesForPr(prKey);
  for (const [sessionKey] of sessionEntries) sessions.delete(sessionKey);
  cwdByPr.delete(prKey);
  reviewContextByPr.delete(prKey);
  deleteEntriesWithPrefix(lastPromptByPr, prefix);
  deleteEntriesWithPrefix(promptQueueByPr, prefix);
  deleteEntriesWithPrefix(promptStateByPr, prefix);
  for (const [, sessionPromise] of sessionEntries) {
    const session = await sessionPromise;
    await session.abort();
    session.dispose();
  }
}

export async function disposePiSessions(): Promise<void> {
  const settled = await Promise.allSettled([...sessions.values()]);
  sessions.clear();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    try {
      await result.value.abort();
      result.value.dispose();
    } catch (error) {
      logger.debug("pi", "dispose ignored failure", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function sessionEventFromUnknown(event: unknown): AgentSessionEvent | null {
  if (typeof event !== "object" || event == null || !("type" in event) || typeof event.type !== "string") return null;
  return event as AgentSessionEvent;
}

/** Extract bounded text from a streaming or final SDK tool result. */
function resultText(result: unknown, maxChars = 12_000): string {
  if (typeof result !== "object" || result == null || !("content" in result) || !Array.isArray(result.content)) return "";
  const text = result.content.map((part) => {
    if (typeof part !== "object" || part == null || !("text" in part) || typeof part.text !== "string") return "";
    return part.text;
  }).join("\n").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… truncated ${text.length - maxChars} chars …`;
}

function promptEventFromSessionEvent(sessionEvent: AgentSessionEvent): PiPromptEvent | null {
  if (sessionEvent.type === "message_update") {
    const delta = sessionEvent.assistantMessageEvent?.type === "thinking_delta" ? sessionEvent.assistantMessageEvent.delta : undefined;
    return typeof delta === "string" && delta.length > 0 ? { type: "thinking", delta } : null;
  }
  if (sessionEvent.type !== "tool_execution_start" && sessionEvent.type !== "tool_execution_update" && sessionEvent.type !== "tool_execution_end") return null;
  if (typeof sessionEvent.toolCallId !== "string" || typeof sessionEvent.toolName !== "string") return null;
  let phase: "start" | "update" | "end";
  if (sessionEvent.type === "tool_execution_start") phase = "start";
  else if (sessionEvent.type === "tool_execution_update") phase = "update";
  else phase = "end";
  let output = "";
  if (sessionEvent.type === "tool_execution_update") output = resultText(sessionEvent.partialResult);
  if (sessionEvent.type === "tool_execution_end") output = resultText(sessionEvent.result);
  return {
    type: "tool",
    phase,
    toolCallId: sessionEvent.toolCallId,
    toolName: sessionEvent.toolName,
    detail: summarizeToolArgs(sessionEvent.toolName, "args" in sessionEvent ? sessionEvent.args : undefined),
    ...(output.length === 0 ? {} : { output }),
    ...(sessionEvent.type === "tool_execution_end" ? { isError: sessionEvent.isError === true } : {}),
  };
}

/** Normalize SDK thinking and tool lifecycle events for web session transcripts. */
export function piPromptEventFromSessionEvent(event: unknown): PiPromptEvent | null {
  const sessionEvent = sessionEventFromUnknown(event);
  return sessionEvent == null ? null : promptEventFromSessionEvent(sessionEvent);
}

function textDeltaFromSessionEvent(sessionEvent: AgentSessionEvent): string {
  if (sessionEvent.type !== "message_update" || sessionEvent.assistantMessageEvent?.type !== "text_delta") return "";
  const delta = sessionEvent.assistantMessageEvent as { delta?: string; text?: string };
  return delta.delta ?? delta.text ?? "";
}

function compactLine(text: string, maxChars = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, Math.max(0, maxChars - 1))}…` : compact;
}

function summarizeToolArgs(name: string, args: unknown): string {
  if (args == null || typeof args !== "object") return name;
  const values = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "prompt"] as const) {
    const value = values[key];
    if (typeof value === "string" && value.trim().length > 0) return `${name}: ${compactLine(value)}`;
  }
  return name;
}

function toolCallDetailFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message == null) return null;
  const { content, role } = message as MessageLike;
  if (role != null && role !== "assistant") return null;
  if (!Array.isArray(content)) return null;
  let detail: string | null = null;
  for (const part of content) {
    if (typeof part !== "object" || part == null) continue;
    const item = part as { type?: string; name?: string; arguments?: unknown };
    if (item.type === "toolCall" && typeof item.name === "string") detail = summarizeToolArgs(item.name, item.arguments);
  }
  return detail;
}

export function toolCallDetailFromEvent(event: unknown): string | null {
  const sessionEvent = sessionEventFromUnknown(event);
  return sessionEvent == null ? null : toolCallDetailFromMessage(messageFromSessionEvent(sessionEvent));
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

function messageFromSessionEvent(sessionEvent: AgentSessionEvent): unknown {
  return sessionEvent.type === "message_update" || sessionEvent.type === "message_end" || sessionEvent.type === "turn_end" ? sessionEvent.message : null;
}

function errorFromMessage(message: unknown): string | null {
  if (typeof message !== "object" || message == null) return null;
  const { errorMessage, role, stopReason } = message as MessageLike;
  if (role !== "assistant" || stopReason !== "error") return null;
  return errorMessage ?? "Assistant stopped with an error.";
}

async function runPiPrompt(prKey: string, prompt: string, purpose = "chat", onDelta?: (delta: string) => void, onEvent?: (event: PiPromptEvent) => void): Promise<string> {
  const startedAt = performance.now();
  const sessionKey = sessionKeyForPr(prKey, purpose);
  const session = await getSession(prKey, purpose);
  let answer = "";
  let latestAssistantText = "";
  let latestAssistantError: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    const now = new Date().toISOString();
    const message = messageFromSessionEvent(event);
    const toolDetail = toolCallDetailFromMessage(message);
    const promptEvent = promptEventFromSessionEvent(event);
    if (promptEvent != null) onEvent?.(promptEvent);
    const previousState = promptStateByPr.get(sessionKey);
    if (previousState != null) promptStateByPr.set(sessionKey, { ...previousState, lastActivityAt: now, ...(toolDetail != null ? { detail: toolDetail } : {}) });
    const assistantText = textFromMessage(message);
    if (assistantText.trim().length > 0) latestAssistantText = assistantText;
    latestAssistantError = errorFromMessage(message) ?? latestAssistantError;
    const delta = textDeltaFromSessionEvent(event);
    if (delta.length === 0) return;
    answer += delta;
    const state = promptStateByPr.get(sessionKey);
    if (state != null) promptStateByPr.set(sessionKey, { ...state, answerChars: answer.length, lastActivityAt: now });
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

export async function askPi(prKey: string, prompt: string, purpose = "chat", onDelta?: (delta: string) => void, onEvent?: (event: PiPromptEvent) => void): Promise<string> {
  const sessionKey = sessionKeyForPr(prKey, purpose);
  const previous = promptQueueByPr.get(sessionKey) ?? Promise.resolve();
  const queuedAt = new Date().toISOString();
  promptStateByPr.set(sessionKey, { status: "queued", purpose, chars: prompt.length, queuedAt, lastActivityAt: queuedAt });
  let releaseQueue: () => void = () => undefined;
  const ready = previous.catch(() => undefined);
  const queued = ready.then(() => new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  }));
  promptQueueByPr.set(sessionKey, queued);
  await ready;
  const startedAt = new Date().toISOString();
  promptStateByPr.set(sessionKey, { status: "running", purpose, chars: prompt.length, queuedAt: promptStateByPr.get(sessionKey)?.queuedAt ?? startedAt, startedAt, lastActivityAt: startedAt });
  try {
    const answer = await runPiPrompt(prKey, prompt, purpose, onDelta, onEvent);
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
