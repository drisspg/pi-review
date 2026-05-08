import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { logger } from "./logger.js";

type SessionRecord = {
  abort?: () => Promise<void>;
  dispose?: () => void;
  prompt: (text: string) => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
};

const sessions = new Map<string, Promise<SessionRecord>>();
const cwdByPr = new Map<string, string>();

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

export async function askPi(prKey: string, prompt: string): Promise<string> {
  const startedAt = performance.now();
  const session = await getSession(prKey);
  let answer = "";
  const unsubscribe = session.subscribe((event) => {
    answer += textDeltaFromEvent(event);
  });
  logger.info("pi", "prompt start", { prKey, chars: prompt.length });
  try {
    await session.prompt(prompt);
    logger.info("pi", "prompt complete", { prKey, ms: Math.round(performance.now() - startedAt), answerChars: answer.length });
    return answer.trim() || "Pi completed without streamed text.";
  } finally {
    unsubscribe();
  }
}
