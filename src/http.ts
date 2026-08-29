import type { IncomingMessage, ServerResponse } from "node:http";

import { parsePullRequestRef } from "./pr.js";

export type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

export class MalformedJsonError extends Error {
  constructor() {
    super("Malformed JSON request body");
    this.name = "MalformedJsonError";
  }
}

export function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch {
        reject(new MalformedJsonError());
      }
    });
    req.on("error", reject);
  });
}

export function inputFromBody(body: unknown): string {
  if (typeof body !== "object" || body == null || !("input" in body) || typeof body.input !== "string") {
    throw new Error("Expected JSON body with an input string");
  }
  return body.input;
}

export function recordFromBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body == null) throw new Error("Expected JSON body");
  return body as Record<string, unknown>;
}

export function refFromBody(body: unknown) {
  const payload = recordFromBody(body);
  if (typeof payload.prUrl !== "string") throw new Error("Expected prUrl");
  return parsePullRequestRef(payload.prUrl);
}

export { prKey as prKeyForRef } from "./pr.js";
