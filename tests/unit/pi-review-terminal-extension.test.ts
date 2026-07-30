import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piReviewTerminalExtension from "../../src/pi-review-terminal-extension.js";

test("terminal extension routes inline comment requests to Pi Review", async () => {
  let tool: { promptGuidelines?: string[]; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> } | null = null;
  let promptHandler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | null = null;
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ created: true, comment: { path: "src/a.ts", line: 9 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Missing test server address");
  const previousEnv = { apiUrl: process.env.PI_REVIEW_API_URL, prKey: process.env.PI_REVIEW_PR_KEY, headSha: process.env.PI_REVIEW_HEAD_SHA, target: process.env.PI_REVIEW_TARGET };
  Object.assign(process.env, {
    PI_REVIEW_API_URL: `http://127.0.0.1:${address.port}`,
    PI_REVIEW_PR_KEY: "github.com/org/repo#1",
    PI_REVIEW_HEAD_SHA: "abcdef1234567",
    PI_REVIEW_TARGET: JSON.stringify({ path: "src/a.ts", line: 9, side: "RIGHT" }),
  });
  try {
    piReviewTerminalExtension({
      registerTool(definition) { tool = definition as typeof tool; },
      on(event, handler) { if (event === "before_agent_start") promptHandler = handler as typeof promptHandler; },
    } as unknown as ExtensionAPI);
    assert.ok(tool != null);
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /instead of editing repository files/);
    assert.match(promptHandler?.({ systemPrompt: "base" }).systemPrompt ?? "", /Do not modify repository files/);

    const result = await tool.execute("call", { body: "Please cover this case." }, undefined, undefined, undefined);
    assert.match(result.content[0].text, /Created editable review draft/);
    assert.deepEqual(requests, [{ prKey: "github.com/org/repo#1", headSha: "abcdef1234567", path: "src/a.ts", line: 9, side: "RIGHT", body: "Please cover this case." }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error)));
    for (const [key, value] of Object.entries({ PI_REVIEW_API_URL: previousEnv.apiUrl, PI_REVIEW_PR_KEY: previousEnv.prKey, PI_REVIEW_HEAD_SHA: previousEnv.headSha, PI_REVIEW_TARGET: previousEnv.target })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
