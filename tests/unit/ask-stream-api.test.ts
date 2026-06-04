import assert from "node:assert/strict";
import test from "node:test";

import { createAskStreamApi, type AskStreamResponse } from "../../src/ask-stream-api.js";

function fakeResponse(): AskStreamResponse & { chunks: string[]; headers: Record<string, string> | null; status: number | null; ended: boolean } {
  return {
    chunks: [],
    ended: false,
    headers: null,
    status: null,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk: string) {
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
}

function events(chunks: string[]): string[] {
  return chunks.join("").trim().split("\n\n");
}

test("ask stream writes delta and done SSE events", async () => {
  const calls: string[] = [];
  const res = fakeResponse();
  const api = createAskStreamApi({
    async askPi(prKey, prompt, purpose, onDelta) {
      calls.push(`${prKey}:${prompt}:${purpose}`);
      onDelta("hello");
      onDelta(" world");
      return "answer";
    },
  });

  await api.stream(res, { prKey: "pr", prompt: "prompt", purpose: "chat" });

  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, {
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  assert.deepEqual(events(res.chunks), [
    'event: delta\ndata: {"delta":"hello"}',
    'event: delta\ndata: {"delta":" world"}',
    'event: done\ndata: {"answer":"answer"}',
  ]);
  assert.equal(res.ended, true);
  assert.deepEqual(calls, ["pr:prompt:chat"]);
});

test("ask stream defaults logged purpose to chat while passing undefined purpose", async () => {
  const logs: unknown[] = [];
  const calls: unknown[] = [];
  const res = fakeResponse();
  const api = createAskStreamApi({
    logger: {
      info(_scope, _message, data) {
        logs.push(data);
      },
      error(_scope, _message, data) {
        logs.push(data);
      },
    },
    async askPi(prKey, prompt, purpose) {
      calls.push({ prKey, prompt, purpose });
      return "answer";
    },
  });

  await api.stream(res, { prKey: "pr", prompt: "prompt" });

  assert.deepEqual(calls, [{ prKey: "pr", prompt: "prompt", purpose: undefined }]);
  assert.deepEqual(logs, [
    { prKey: "pr", purpose: "chat", chars: 6 },
    { prKey: "pr", purpose: "chat", answerChars: 6 },
  ]);
});

test("ask stream writes error SSE events when ask fails", async () => {
  const res = fakeResponse();
  const api = createAskStreamApi({
    async askPi(_prKey, _prompt, _purpose, onDelta) {
      onDelta("partial");
      throw new Error("boom");
    },
  });

  await api.stream(res, { prKey: "pr", prompt: "prompt" });

  assert.deepEqual(events(res.chunks), [
    'event: delta\ndata: {"delta":"partial"}',
    'event: error\ndata: {"error":"boom"}',
  ]);
  assert.equal(res.ended, true);
});

test("ask stream validates payload before opening SSE response", async () => {
  const res = fakeResponse();
  const api = createAskStreamApi({
    async askPi() {
      return "unused";
    },
  });

  await assert.rejects(api.stream(res, { prKey: "pr" }), /Expected prKey and prompt/);
  assert.equal(res.status, null);
  assert.equal(res.ended, false);
});
