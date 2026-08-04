export type PiTerminalApiDeps = {
  deleteSession: (prKey: string, session: string) => Promise<void>;
};

export type PiTerminalApi = ReturnType<typeof createPiTerminalApi>;

export function createPiTerminalApi(deps: PiTerminalApiDeps) {
  async function remove(payload: Record<string, unknown>): Promise<{ ok: true }> {
    if (typeof payload.prKey !== "string" || payload.prKey.trim().length === 0 || typeof payload.session !== "string" || payload.session.trim().length === 0) throw new Error("Expected terminal prKey and session");
    await deps.deleteSession(payload.prKey.trim(), payload.session.trim());
    return { ok: true };
  }

  return { remove };
}
