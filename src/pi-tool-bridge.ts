/** Keep stateful review/GPU tools in the server while Pi runs under the user's launcher. */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export type PiToolMetadata = { name: string; sourceInfo?: unknown };

/** Expose only this session's custom tools on a token-protected loopback endpoint. */
export async function createPiToolBridge(tools: ToolDefinition[]) {
  const token = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  const executions = new Set<Promise<unknown>>();
  const metadata: { ready: boolean; tools: PiToolMetadata[]; activeTools: string[] } = { ready: false, tools: [], activeTools: [] };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin != null) {
      res.writeHead(403).end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    res.on("close", () => controller.abort());
    try {
      if (req.method === "GET" && req.url === "/tools") {
        res.end(JSON.stringify({ tools: tools.map(({ execute, ...definition }) => definition) }));
        return;
      }
      if (req.method !== "POST" || (req.url !== "/execute" && req.url !== "/metadata")) {
        res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1_000_000) throw new Error("Tool request too large");
      }
      const payload = JSON.parse(body);
      if (req.url === "/metadata") {
        if (!Array.isArray(payload.tools) || !Array.isArray(payload.activeTools)) throw new Error("Invalid tool metadata");
        metadata.tools = payload.tools;
        metadata.activeTools = payload.activeTools;
        metadata.ready = true;
        res.end("{}");
        return;
      }
      const tool = tools.find((candidate) => candidate.name === payload.name);
      if (tool == null) throw new Error("Unknown session tool");
      // Existing review tools depend only on validated params and server-owned state,
      // not ExtensionContext. Validation and extension hooks still run in the CLI.
      const execution = Promise.resolve().then(() => tool.execute(payload.id, payload.params, controller.signal, undefined, undefined as never));
      executions.add(execution);
      try {
        res.end(JSON.stringify({ result: await execution }));
      } finally {
        executions.delete(execution);
      }
    } catch (error) {
      res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    } finally {
      controllers.delete(controller);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Pi tool bridge did not bind");
  return {
    env: { PI_REVIEW_TOOL_URL: `http://127.0.0.1:${address.port}`, PI_REVIEW_TOOL_TOKEN: token },
    metadata,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      // Abort can return before a server-owned tool finishes committing state.
      // Preserve the checkout-transition barrier until those executions settle.
      await Promise.allSettled(executions);
    },
  };
}
