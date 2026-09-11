/** Register server-owned tools inside launcher-authenticated background Pi sessions. */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installReviewWorkspaceGuidance } from "./pi-review-workspace.js";

export default async function piReviewAgentExtension(pi: ExtensionAPI) {
  installReviewWorkspaceGuidance(pi);
  const url = process.env.PI_REVIEW_TOOL_URL;
  const token = process.env.PI_REVIEW_TOOL_TOKEN;
  if (!url || !token) throw new Error("Pi Review did not provide the session tool bridge");

  /** Keep requests private to the owning server and surface tool failures to Pi. */
  async function request(route: string, payload?: unknown, signal?: AbortSignal) {
    const response = await fetch(`${url}${route}`, {
      method: payload == null ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(payload == null ? {} : { body: JSON.stringify(payload) }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { tools: ToolDefinition[]; result: Awaited<ReturnType<ToolDefinition["execute"]>>; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Pi Review tool request failed (${response.status})`);
    return body;
  }

  for (const tool of (await request("/tools")).tools) {
    pi.registerTool({
      ...tool,
      execute: async (id, params, signal) => (await request("/execute", { name: tool.name, id, params }, signal)).result,
    });
  }
  pi.on("session_start", async () => {
    await request("/metadata", { tools: pi.getAllTools().map(({ name, sourceInfo }) => ({ name, sourceInfo })), activeTools: pi.getActiveTools() });
  });
}
