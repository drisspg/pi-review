import assert from "node:assert/strict";
import test from "node:test";

import { toolCallDetailFromEvent } from "../../src/pi-session.js";

function assistantEvent(content: unknown): unknown {
  return { type: "message_update", message: { role: "assistant", content } };
}

test("summarizes a bash tool call with its command", () => {
  const event = assistantEvent([{ type: "toolCall", name: "bash", arguments: { command: "npm run typecheck" } }]);
  assert.equal(toolCallDetailFromEvent(event), "bash: npm run typecheck");
});

test("summarizes a read tool call with its path", () => {
  const event = assistantEvent([{ type: "toolCall", name: "read", arguments: { path: "src/server.ts" } }]);
  assert.equal(toolCallDetailFromEvent(event), "read: src/server.ts");
});

test("falls back to the tool name when no known arg is present", () => {
  const event = assistantEvent([{ type: "toolCall", name: "goal", arguments: { steps: 3 } }]);
  assert.equal(toolCallDetailFromEvent(event), "goal");
});

test("uses the last tool call when several are present", () => {
  const event = assistantEvent([
    { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
    { type: "toolCall", name: "bash", arguments: { command: "ls" } },
  ]);
  assert.equal(toolCallDetailFromEvent(event), "bash: ls");
});

test("collapses whitespace and truncates long commands", () => {
  const command = `git log ${"x".repeat(200)}`;
  const detail = toolCallDetailFromEvent(assistantEvent([{ type: "toolCall", name: "bash", arguments: { command } }]));
  assert.ok(detail != null && detail.startsWith("bash: git log "));
  assert.ok(detail.length <= "bash: ".length + 80);
});

test("ignores text-only assistant messages", () => {
  assert.equal(toolCallDetailFromEvent(assistantEvent([{ type: "text", text: "thinking out loud" }])), null);
});

test("ignores non-assistant messages", () => {
  const event = { type: "message_update", message: { role: "user", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } };
  assert.equal(toolCallDetailFromEvent(event), null);
});

test("ignores events without a message", () => {
  assert.equal(toolCallDetailFromEvent({ type: "text_delta", delta: "hi" }), null);
});
