export type AskStreamDeps = {
  askPi: (prKey: string, prompt: string, purpose: string | undefined, onDelta: (delta: string) => void) => Promise<string>;
  logger?: {
    info: (scope: string, message: string, data?: Record<string, unknown>) => void;
    error: (scope: string, message: string, data?: Record<string, unknown>) => void;
  };
};

export type AskStreamResponse = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  write: (chunk: string) => void;
  end: () => void;
};

export type AskStreamPayload = {
  prKey: string;
  prompt: string;
  purpose?: string;
};

function parseAskStreamPayload(payload: Record<string, unknown>): AskStreamPayload {
  if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
  return { prKey: payload.prKey, prompt: payload.prompt, purpose: typeof payload.purpose === "string" ? payload.purpose : undefined };
}

function writeSse(res: AskStreamResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createAskStreamApi(deps: AskStreamDeps) {
  async function stream(res: AskStreamResponse, payload: Record<string, unknown>): Promise<void> {
    const request = parseAskStreamPayload(payload);
    res.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    });
    deps.logger?.info("pi", "stream prompt start", { prKey: request.prKey, purpose: request.purpose ?? "chat", chars: request.prompt.length });
    try {
      const answer = await deps.askPi(request.prKey, request.prompt, request.purpose, (delta) => writeSse(res, "delta", { delta }));
      writeSse(res, "done", { answer });
      deps.logger?.info("pi", "stream prompt done", { prKey: request.prKey, purpose: request.purpose ?? "chat", answerChars: answer.length });
    } catch (error) {
      deps.logger?.error("pi", "stream prompt failed", { prKey: request.prKey, purpose: request.purpose ?? "chat", error: error instanceof Error ? error.message : String(error) });
      writeSse(res, "error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      res.end();
    }
  }

  return { stream };
}
