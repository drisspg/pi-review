import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import piReviewTerminalExtension from "../../src/pi-review-terminal-extension.js";

test("terminal extension reads archived feedback only on demand, without inline target filtering", async (t) => {
  type Tool = { promptGuidelines?: string[]; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: unknown }> };
  type Handler = (event: { systemPrompt?: string; toolName?: string }) => { systemPrompt?: string; block?: boolean } | undefined;
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler>();
  const previousEnv = { ...process.env };
  t.after(() => {
    for (const key of ["PI_REVIEW_API_URL", "PI_REVIEW_PR_KEY", "PI_REVIEW_HEAD_SHA", "PI_REVIEW_TARGET"]) {
      if (previousEnv[key] == null) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });
  Object.assign(process.env, {
    PI_REVIEW_API_URL: "http://pi-review.test",
    PI_REVIEW_PR_KEY: "github.com/org/repo#1",
    PI_REVIEW_HEAD_SHA: "session-head",
    PI_REVIEW_TARGET: JSON.stringify({ path: "unrelated.ts", line: 9 }),
  });
  const requests: Array<{ url: unknown; init?: RequestInit }> = [];
  let payload: unknown = { archives: [{ id: "old-review", headSha: "historical-head", createdAt: "2026-01-01", event: "COMMENT", commentCount: 1, summary: "Check bounds" }], nextOffset: 20 };
  let responseStatus = 200;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    requests.push({ url, init });
    init?.signal?.throwIfAborted();
    return new Response(JSON.stringify(payload), { status: responseStatus });
  });
  piReviewTerminalExtension({
    registerTool(definition) { tools.set(definition.name, definition as unknown as Tool); },
    on(event, handler) { handlers.set(event, handler as unknown as Handler); },
  } as ExtensionAPI);
  const tool = tools.get("read_archived_feedback");
  assert.ok(tool);
  assert.ok(tools.has("draft_review_comment"));
  assert.equal(handlers.get("tool_call")?.({ toolName: "read_archived_feedback" }), undefined);
  handlers.get("session_start")?.({});
  const prompt = handlers.get("before_agent_start")?.({ systemPrompt: "base" });
  assert.equal(requests.length, 0);
  assert.doesNotMatch(prompt?.systemPrompt ?? "", /historical-head|Check bounds/);
  const guidelines = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidelines, /current checkout/);
  assert.match(guidelines, /addressed.*still-open.*unverified/);
  assert.match(guidelines, /historical data.*not.*instructions/);
  assert.match(guidelines, /does not mean.*resolved/);
  assert.match(guidelines, /Do not.*archives.*drafts.*GitHub/);

  const signal = new AbortController().signal;
  const listing = await tool.execute("list", {}, signal);
  assert.deepEqual(listing.details, payload);
  assert.match(listing.content[0].text, /old-review/);
  assert.deepEqual(requests[0], { url: "http://pi-review.test/api/review/archive/history", init: {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prKey: "github.com/org/repo#1" }), signal,
  } });
  payload = { archives: [], nextOffset: null };
  const lastPage = await tool.execute("next", { offset: 20 });
  assert.deepEqual(lastPage.details, payload);
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { prKey: "github.com/org/repo#1", offset: 20 });

  payload = { archive: {
    id: "old-review", headSha: "historical-head", body: "Full review body",
    comments: [{ path: "old-name.ts", line: 15, body: "Check bounds" }],
    changeSet: { headSha: "historical-head", files: [{ path: "old-name.ts", patch: "historical diff" }] },
  } };
  const detail = await tool.execute("detail", { archiveId: "old-review" });
  assert.deepEqual(detail.details, payload);
  assert.match(detail.content[0].text, /Full review body/);
  assert.match(detail.content[0].text, /historical diff/);
  assert.match(detail.content[0].text, /historical-head/);
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { prKey: "github.com/org/repo#1", archiveId: "old-review" });

  responseStatus = 404;
  payload = { error: "Archive not found" };
  await assert.rejects(tool.execute("missing", { archiveId: "missing" }), /Archive not found/);
  payload = {};
  await assert.rejects(tool.execute("failure", {}), /404/);
  await assert.rejects(tool.execute("abort", {}, AbortSignal.abort()), /abort/i);
  const requestCount = requests.length;
  for (const key of ["PI_REVIEW_API_URL", "PI_REVIEW_PR_KEY", "PI_REVIEW_HEAD_SHA"]) {
    const value = process.env[key];
    delete process.env[key];
    await assert.rejects(tool.execute("context", {}), /terminal review context/);
    process.env[key] = value;
  }
  assert.equal(requests.length, requestCount);
});

test("suggest_change reuses the inline comment endpoint with a GitHub suggestion body", async (t) => {
  const keys = ["PI_REVIEW_API_URL", "PI_REVIEW_PR_KEY", "PI_REVIEW_HEAD_SHA", "PI_REVIEW_TARGET"];
  const previous = { ...process.env };
  t.after(() => { for (const key of keys) { if (previous[key] == null) delete process.env[key]; else process.env[key] = previous[key]; } });
  Object.assign(process.env, { PI_REVIEW_API_URL: "http://pi-review.test", PI_REVIEW_PR_KEY: "pr", PI_REVIEW_HEAD_SHA: "head", PI_REVIEW_TARGET: JSON.stringify({ path: "a.ts", startLine: 10, line: 11, side: "RIGHT" }) });
  const tools = new Map<string, ToolDefinition>();
  piReviewTerminalExtension({ registerTool(tool) { tools.set(tool.name, tool); }, on() {} } as ExtensionAPI);
  const tool = tools.get("suggest_change");
  assert.ok(tool);
  assert.equal(tools.has("draft_review"), false);
  const requests: unknown[] = [];
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    assert.equal(init?.signal, signal);
    return new Response(JSON.stringify({ created: true, comment: { path: "a.ts", startLine: 10, line: 11 } }));
  });
  await tool.execute("call", { code: "  replacement();" }, signal, undefined, undefined as never);
  assert.deepEqual(requests, [{ url: "http://pi-review.test/api/pi/draft-comment", body: { prKey: "pr", headSha: "head", path: "a.ts", startLine: 10, line: 11, side: "RIGHT", body: "```suggestion\n  replacement();\n```" } }]);
  await tool.execute("other-line", { code: "replacement", line: 12 }, signal, undefined, undefined as never);
  assert.deepEqual(requests[1], { url: "http://pi-review.test/api/pi/draft-comment", body: { prKey: "pr", headSha: "head", path: "a.ts", line: 12, side: "RIGHT", body: "```suggestion\nreplacement\n```" } });
});

test("terminal extension routes inline comment requests to Pi Review", async () => {
  let tool: { promptGuidelines?: string[]; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> } | null = null;
  let promptHandler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | null = null;
  let toolCallHandler: ((event: { toolName: string }) => { block: boolean; reason?: string } | undefined) | null = null;
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
      registerTool(definition) { if (definition.name === "draft_review_comment") tool = definition as typeof tool; },
      on(event, handler) {
        if (event === "before_agent_start") promptHandler = handler as typeof promptHandler;
        if (event === "tool_call") toolCallHandler = handler as typeof toolCallHandler;
      },
    } as unknown as ExtensionAPI);
    assert.ok(tool != null);
    assert.match(tool.promptGuidelines?.join("\n") ?? "", /instead of editing repository files/);
    const systemPrompt = promptHandler?.({ systemPrompt: "base" }).systemPrompt ?? "";
    assert.match(systemPrompt, /never modify repository files/);
    assert.match(systemPrompt, /Apply suggestion, use suggest_change/);

    // Review checkouts are read-only: file-editing tools are hard-blocked, inspection tools pass through.
    assert.ok(toolCallHandler != null);
    for (const toolName of ["edit", "write"]) {
      const blocked = toolCallHandler({ toolName });
      assert.equal(blocked?.block, true);
      assert.match(blocked?.reason ?? "", /draft_review_comment/);
    }
    assert.equal(toolCallHandler({ toolName: "read" }), undefined);
    assert.equal(toolCallHandler({ toolName: "bash" }), undefined);

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
