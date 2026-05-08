import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import { logger } from "./logger.js";

type SessionRecord = {
  prompt: (text: string) => Promise<void>;
  subscribe: (listener: (event: unknown) => void) => () => void;
};

const sessions = new Map<string, Promise<SessionRecord>>();

async function createSession(prKey: string): Promise<SessionRecord> {
  logger.info("pi", "create session", { prKey, cwd: process.cwd() });
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    noTools: "all",
    sessionManager: SessionManager.create(process.cwd()),
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
