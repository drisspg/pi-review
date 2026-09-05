export type PiApiDeps = {
  askPi: (prKey: string, prompt: string, purpose?: string) => Promise<string>;
  piDiagnostics: (prKey: string) => Promise<unknown>;
  setPiModel: (prKey: string, provider: string, modelId: string, thinkingLevel?: string) => Promise<unknown>;
};

export type PiApi = {
  ask: (payload: Record<string, unknown>) => Promise<{ answer: string }>;
  diagnostics: (payload: Record<string, unknown>) => Promise<{ diagnostics: unknown }>;
  setModel: (payload: Record<string, unknown>) => Promise<{ diagnostics: unknown }>;
};

function promptPayload(payload: Record<string, unknown>): { prKey: string; prompt: string; purpose?: string } {
  if (typeof payload.prKey !== "string" || typeof payload.prompt !== "string") throw new Error("Expected prKey and prompt");
  return { prKey: payload.prKey, prompt: payload.prompt, purpose: typeof payload.purpose === "string" ? payload.purpose : undefined };
}

export function createPiApi(deps: PiApiDeps): PiApi {
  async function ask(payload: Record<string, unknown>): Promise<{ answer: string }> {
    const request = promptPayload(payload);
    return { answer: await deps.askPi(request.prKey, request.prompt, request.purpose) };
  }

  async function diagnostics(payload: Record<string, unknown>): Promise<{ diagnostics: unknown }> {
    if (typeof payload.prKey !== "string") throw new Error("Expected prKey");
    return { diagnostics: await deps.piDiagnostics(payload.prKey) };
  }

  async function setModel(payload: Record<string, unknown>): Promise<{ diagnostics: unknown }> {
    if (typeof payload.prKey !== "string" || typeof payload.provider !== "string" || typeof payload.modelId !== "string") throw new Error("Expected prKey, provider, and modelId");
    return { diagnostics: await deps.setPiModel(payload.prKey, payload.provider, payload.modelId, typeof payload.thinkingLevel === "string" ? payload.thinkingLevel : undefined) };
  }

  return { ask, diagnostics, setModel };
}
