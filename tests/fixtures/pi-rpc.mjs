#!/usr/bin/env node
/** Offline launcher fixture: real pipes and tool HTTP calls, no model or GitHub traffic. */
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (option("--mode") !== "rpc") throw new Error("Expected RPC launch");
const state = {
  model: { provider: option("--provider"), id: option("--model"), name: "Fixture" },
  thinkingLevel: option("--thinking"), sessionId: "fixture", isStreaming: false,
};
const headers = { authorization: `Bearer ${process.env.PI_REVIEW_TOOL_TOKEN}`, "content-type": "application/json" };
const endpoint = process.env.PI_REVIEW_TOOL_URL;
const tools = (await (await fetch(`${endpoint}/tools`, { headers })).json()).tools;
if (state.model.id !== "missing-extension") {
  await fetch(`${endpoint}/metadata`, { method: "POST", headers, body: JSON.stringify({ tools, activeTools: tools.map((tool) => tool.name) }) });
}
if (state.model.id === "fallback") state.model.provider = "personal";

/** Emit complete JSON records, optionally splitting a UTF-8 character across pipe writes. */
function emit(packet, split = false) {
  const buffer = Buffer.from(JSON.stringify(packet) + "\n");
  const at = split ? buffer.indexOf(Buffer.from("é")) + 1 : buffer.length;
  process.stdout.write(buffer.subarray(0, at));
  if (at < buffer.length) process.stdout.write(buffer.subarray(at));
}
const assistant = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });

/** Fake a retry, custom tool call, and final settlement as distinct lifecycle events. */
async function handle(command) {
  const reply = (data) => emit({ type: "response", id: command.id, success: true, data });
  if (command.type === "get_state") return reply(state);
  if (command.type === "get_available_models") return reply({ models: [state.model] });
  if (command.type === "get_available_thinking_levels") return reply({ levels: ["off", "low", "high"] });
  if (command.type === "set_model") { state.model = { provider: command.provider, id: command.modelId }; return reply(state.model); }
  if (command.type === "set_thinking_level") { state.thinkingLevel = command.level; return reply(); }
  if (command.type === "abort") {
    state.isStreaming = false;
    emit({ type: "message_end", message: assistant("", "aborted") });
    emit({ type: "agent_settled" });
    return reply();
  }
  if (command.type !== "prompt") throw new Error(`Unexpected command ${command.type}`);
  reply();
  if (command.message === "exit") return process.exit(7);
  if (command.message === "/handled") return;
  state.isStreaming = true;
  emit({ type: "agent_start" });
  if (command.message === "hang") return;
  emit({ type: "message_end", message: { ...assistant("", "error"), errorMessage: "retry me" } });
  emit({ type: "agent_end", willRetry: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (tools.length) {
    const result = await (await fetch(`${endpoint}/execute`, { method: "POST", headers, body: JSON.stringify({ name: tools[0].name, id: "tool-1", params: { value: command.message } }) })).json();
    emit({ type: "tool_execution_end", toolName: tools[0].name, toolCallId: "tool-1", result: result.result, isError: false });
  }
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: command.message } }, true);
  emit({ type: "message_end", message: assistant(command.message) }, true);
  emit({ type: "agent_end", willRetry: false });
  state.isStreaming = false;
  emit({ type: "agent_settled" });
}

process.stdout.write("fixture launcher banner\n");
let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  input += chunk;
  let end;
  while ((end = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    void handle(JSON.parse(line));
  }
});
