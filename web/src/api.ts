import type { PiSessionEvent } from "./types";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export async function askPi(payload: { prKey: string; prompt: string; purpose?: string }, onDelta?: (answer: string) => void, onEvent?: (event: PiSessionEvent) => void): Promise<string> {
  try {
    const streamed = await streamAskPi(payload, onDelta, onEvent);
    if (streamed != null) return streamed;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  const { answer } = await api<{ answer: string }>("/api/ask", { method: "POST", body: JSON.stringify(payload) });
  onDelta?.(answer);
  return answer;
}

async function streamAskPi(payload: { prKey: string; prompt: string; purpose?: string }, onDelta?: (answer: string) => void, onEvent?: (event: PiSessionEvent) => void): Promise<string | null> {
  if (onDelta == null) return null;
  const response = await fetch("/api/ask/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok || response.body == null) return null;

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let answer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const eventText of events) {
      const event = parseSseEvent(eventText);
      if (event == null) continue;
      if (event.event === "delta" && typeof event.data.delta === "string") {
        answer += event.data.delta;
        onDelta(answer);
      } else if (event.event === "session") {
        onEvent?.(event.data as PiSessionEvent);
      } else if (event.event === "done" && typeof event.data.answer === "string") {
        return event.data.answer;
      } else if (event.event === "error") {
        throw new Error(typeof event.data.error === "string" ? event.data.error : "Ask Pi failed");
      }
    }
  }
  return answer.length > 0 ? answer : null;
}

function parseSseEvent(text: string): { event: string; data: Record<string, unknown> } | null {
  const event = text.split("\n").find((line) => line.startsWith("event: "))?.slice("event: ".length);
  const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice("data: ".length);
  if (event == null || data == null) return null;
  return { event, data: JSON.parse(data) as Record<string, unknown> };
}
