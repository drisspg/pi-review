import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { createRequestListener, createServerRoute, type ServerRoute, type ServerRouteDeps } from "../../src/server-router.js";

class FakeResponse extends EventEmitter {
  body = "";
  ended = false;
  headers: Record<string, string> = {};
  statusCode = 200;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
  }

  write(chunk: string | Buffer) {
    this.body += chunk.toString();
  }

  end(chunk?: string | Buffer) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.emit("finish");
  }
}

function fakeRequest(method: string, url: string, body?: unknown): IncomingMessage {
  return fakeRawRequest(method, url, body === undefined ? undefined : JSON.stringify(body));
}

function fakeRawRequest(method: string, url: string, body?: string): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [body]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "test.local" };
  return req;
}

async function routeRequest(route: ServerRoute, method: string, url: string, body?: unknown): Promise<FakeResponse> {
  const res = new FakeResponse();
  await route(fakeRequest(method, url, body), res as unknown as ServerResponse);
  return res;
}

function jsonBody(res: FakeResponse): unknown {
  return JSON.parse(res.body);
}

function baseDeps(overrides: Partial<ServerRouteDeps> = {}): ServerRouteDeps {
  const logger = {
    entries() {
      return [];
    },
    error() {},
    info() {},
  };
  return {
    askStreamApi: {
      async stream(res) {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.end();
      },
    },
    commentApi: {
      async edit() {
        return { result: "edit" };
      },
      async reply() {
        return { result: "reply" };
      },
    },
    draftReviewApi: {
      async save(payload) {
        return { draftReview: { prKey: String(payload.prKey), headSha: "head", event: "COMMENT", body: "", comments: [], updatedAt: "now" } };
      },
    },
    fileApi: {
      async open() {
        return { target: "target" };
      },
      async text() {
        return { text: "text" };
      },
      async viewed() {
        return { fileReview: { fingerprint: "fp", path: "p", prKey: "pr", updatedAt: "now", viewed: true } };
      },
    },
    async gpuWorkspaceCreateResponse() {
      return { workspace: { id: "gpu" } };
    },
    async gpuWorkspaceDeleteResponse() {
      return { result: { id: "gpu" } };
    },
    async gpuWorkspaceExecResponse() {
      return { result: { exitCode: 0, id: "gpu" } };
    },
    async gpuWorkspaceStatusResponse() {
      return { workspace: null };
    },
    logger,
    piApi: {
      async ask(payload) {
        return { answer: `ask:${payload.prompt}` };
      },
      async diagnostics() {
        return { diagnostics: { ok: true } };
      },
      async jobStatus() {
        return { job: { id: "job", prKey: "pr", startedAt: "now", status: "running" } };
      },
      async setModel() {
        return { diagnostics: { ok: true } };
      },
      async startReviewJob(payload, purpose) {
        return { job: { id: `job:${purpose}:${payload.prKey}`, prKey: String(payload.prKey), startedAt: "now", status: "running" } };
      },
    },
    prApi: {
      async activity() {
        return { pr: { existingCommentCount: 0, filesChanged: 0, key: "pr" }, draftReview: null, focusScan: null, focusScans: [], aiReview: null, aiReviews: [] };
      },
      async cleanup() {
        return { prKey: "pr", worktreeDir: "/tmp/pr" };
      },
      async open() {
        return { pr: { existingCommentCount: 0, filesChanged: 0, key: "pr" }, draftReview: null, focusScan: null, focusScans: [], aiReview: null, aiReviews: [], worktreeDir: "/tmp/pr" };
      },
      parse(input) {
        return { ref: { host: "github.com", owner: "o", repo: "r", number: Number(input) || 1 } };
      },
    },
    reviewMemoryApi: {
      async capture() {
        return { memory: { body: "", changeSet: { files: [] }, comments: [], createdAt: "now", event: "COMMENT", headSha: "head", id: "m", prKey: "pr" } };
      },
      async distill() {
        return { profile: "profile" };
      },
      async status() {
        return { prompt: "prompt", profile: null, records: [], stats: { inlineCommentCount: 0, latestCreatedAt: null, prCount: 0, profileSourceRecordCount: null, profileUpdatedAt: null, recordCount: 0 } };
      },
    },
    reviewPromptApi: {
      async build(payload) {
        return { prompt: `prompt:${payload.mode}`, purpose: String(payload.mode) };
      },
    },
    reviewSubmitRouteApi: {
      async submit() {
        return { result: { ok: true }, pr: null };
      },
    },
    savedAnalysisApi: {
      async saveAiReview() {
        return { review: { answer: "answer", createdAt: "now", headSha: "head", id: "ai", prKey: "pr", updatedAt: "now" } };
      },
      async saveFocusScan() {
        return { scan: { answer: "answer", areaStates: {}, createdAt: "now", headSha: "head", id: "scan", prKey: "pr", updatedAt: "now" } };
      },
    },
    async sendStatic(res, pathname, head = false) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(head ? undefined : `static:${pathname}`);
    },
    shellApi: {
      health() {
        return { ok: true };
      },
      logs() {
        return { logs: [{ message: "log" }] };
      },
      async prs() {
        return { prs: [{ key: "pr" }] };
      },
    },
    ...overrides,
  } as ServerRouteDeps;
}

test("server route handles health and OPTIONS without feature deps", async () => {
  const route = createServerRoute(baseDeps());

  const health = await routeRequest(route, "GET", "/api/health");
  assert.equal(health.statusCode, 200);
  assert.deepEqual(jsonBody(health), { ok: true });

  const options = await routeRequest(route, "OPTIONS", "/api/anything");
  assert.equal(options.statusCode, 204);
  assert.equal(jsonBody(options), null);
});

test("server route parses JSON and dispatches POST feature routes", async () => {
  const calls: unknown[] = [];
  const route = createServerRoute(baseDeps({
    piApi: {
      async ask(payload) {
        calls.push(payload);
        return { answer: "answer" };
      },
      async diagnostics() {
        throw new Error("unused");
      },
      async jobStatus() {
        throw new Error("unused");
      },
      async setModel() {
        throw new Error("unused");
      },
      async startReviewJob() {
        throw new Error("unused");
      },
    },
  }));

  const res = await routeRequest(route, "POST", "/api/ask", { prKey: "pr", prompt: "prompt" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(jsonBody(res), { answer: "answer" });
  assert.deepEqual(calls, [{ prKey: "pr", prompt: "prompt" }]);
});

test("server route saves draft reviews", async () => {
  const payloads: Record<string, unknown>[] = [];
  const route = createServerRoute(baseDeps({
    draftReviewApi: {
      async save(payload) {
        payloads.push(payload);
        return { draftReview: { prKey: String(payload.prKey), headSha: "head", event: "COMMENT", body: "body", comments: [], updatedAt: "now" } };
      },
    },
  }));

  const res = await routeRequest(route, "POST", "/api/draft-review/save", { prKey: "pr", body: "body" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(payloads, [{ prKey: "pr", body: "body" }]);
  assert.deepEqual(jsonBody(res), { draftReview: { prKey: "pr", headSha: "head", event: "COMMENT", body: "body", comments: [], updatedAt: "now" } });
});

test("server route exposes backend prompt contracts", async () => {
  const route = createServerRoute(baseDeps());

  const res = await routeRequest(route, "POST", "/api/pi/prompt", { mode: "code-walk" });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(jsonBody(res), { prompt: "prompt:code-walk", purpose: "code-walk" });
});

test("server route uses route-specific status codes", async () => {
  const route = createServerRoute(baseDeps());

  const res = await routeRequest(route, "POST", "/api/pi/review", { prKey: "pr", prompt: "prompt" });

  assert.equal(res.statusCode, 202);
  assert.deepEqual(jsonBody(res), { job: { id: "job:main-review:pr", prKey: "pr", startedAt: "now", status: "running" } });
});

test("server route delegates GET and HEAD misses to static handler", async () => {
  const calls: unknown[] = [];
  const route = createServerRoute(baseDeps({
    async sendStatic(res, pathname, head = false) {
      calls.push({ pathname, head });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(head ? undefined : "static");
    },
  }));

  const get = await routeRequest(route, "GET", "/review/123");
  const head = await routeRequest(route, "HEAD", "/assets/app.js");

  assert.equal(get.body, "static");
  assert.equal(head.body, "");
  assert.deepEqual(calls, [
    { pathname: "/review/123", head: false },
    { pathname: "/assets/app.js", head: true },
  ]);
});

test("server route returns JSON 404 for unsupported methods", async () => {
  const route = createServerRoute(baseDeps());

  const res = await routeRequest(route, "DELETE", "/api/health");

  assert.equal(res.statusCode, 404);
  assert.deepEqual(jsonBody(res), { error: "No route for DELETE /api/health" });
});

test("request listener returns JSON 400 for malformed request bodies", async () => {
  const deps = baseDeps();
  const listener = createRequestListener(createServerRoute(deps), deps.logger);
  const res = new FakeResponse();

  await new Promise<void>((resolve) => {
    res.on("finish", resolve);
    listener(fakeRawRequest("POST", "/api/pi/diagnostics", "{prKey:github.com/pytorch/pytorch#188469}"), res as unknown as ServerResponse);
  });

  assert.equal(res.statusCode, 400);
  assert.deepEqual(jsonBody(res), { error: "Malformed JSON request body" });
});

test("request listener logs and wraps route failures as JSON 500", async () => {
  const logs: unknown[] = [];
  const logger = {
    error(scope: string, message: string, data?: Record<string, unknown>) {
      logs.push({ level: "error", scope, message, data });
    },
    info(scope: string, message: string, data?: Record<string, unknown>) {
      logs.push({ level: "info", scope, message, data });
    },
  };
  const listener = createRequestListener(async () => {
    throw new Error("boom");
  }, logger);
  const res = new FakeResponse();

  await new Promise<void>((resolve) => {
    res.on("finish", resolve);
    listener(fakeRequest("POST", "/api/fail"), res as unknown as ServerResponse);
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(jsonBody(res), { error: "boom" });
  assert.deepEqual(logs.map((entry) => (entry as { message: string }).message), ["request start", "request failed", "request finish"]);
});
