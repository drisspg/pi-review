/** Own interactive Pi processes behind a bounded browser-terminal protocol. */

import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";

import type { IPty } from "node-pty";

import { ghstackWorkspaceInstructions } from "./ghstack-guidance.js";
import type { DraftReview } from "./types.js";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_BUFFER_CHARS = 1_000_000;

export type PiTerminalServerMessage =
  | { type: "ready"; pid: number }
  | { type: "output"; data: string }
  | { type: "draftReview"; draftReview: DraftReview }
  | { type: "exit"; exitCode: number; signal: number }
  | { type: "error"; message: string };

export type PiTerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type PiTerminalTarget = {
  path: string;
  line: number;
  startLine?: number;
  side: "RIGHT" | "LEFT";
};

export type PiTerminalRequest = {
  prKey: string;
  session: string;
  context?: string;
  headSha?: string;
  target?: PiTerminalTarget;
};

export type PiTerminalPeer = {
  send: (message: PiTerminalServerMessage) => void;
  close: (code?: number, reason?: string) => void;
  onMessage: (listener: (message: string) => void) => void;
  onClose: (listener: () => void) => void;
};

type TerminalProcess = Pick<IPty, "kill" | "pid" | "resize" | "write"> & {
  onData: IPty["onData"];
  onExit: IPty["onExit"];
};

type TerminalSession = {
  process: TerminalProcess;
  peers: Set<PiTerminalPeer>;
  buffer: string;
};

export type PiTerminalManagerDeps = {
  cwdForPr: (prKey: string) => string | null;
  logger?: {
    error: (scope: string, message: string, data?: Record<string, unknown>) => void;
    info: (scope: string, message: string, data?: Record<string, unknown>) => void;
  };
  apiUrl?: string;
  extensionPath?: string;
  piCommand?: string;
  sessionRoot?: string;
  spawn?: (command: string, args: string[], options: { cols: number; cwd: string; env: NodeJS.ProcessEnv; name: string; rows: number }) => TerminalProcess;
};

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function boundedDimension(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(max, Math.round(value)));
}

/** Resolve the user-installed Pi CLI without selecting an npm-injected project binary. */
export function resolvePiTerminalCommand(pathValue = process.env.PATH): string {
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const directory of pathValue?.split(delimiter) ?? []) {
    if (directory.length === 0 || /(^|[\\/])node_modules[\\/]\.bin$/.test(directory)) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH until the first executable user installation.
      }
    }
  }
  return "pi";
}

/** Parse and validate a browser terminal connection URL. */
export function parsePiTerminalRequest(url: string, host = "127.0.0.1"): PiTerminalRequest | null {
  const parsed = new URL(url, `http://${host}`);
  if (parsed.pathname !== "/api/pi/terminal") return null;
  const prKey = parsed.searchParams.get("prKey")?.trim() ?? "";
  const session = parsed.searchParams.get("session")?.trim() || "main";
  const context = parsed.searchParams.get("context")?.trim() || undefined;
  const headSha = parsed.searchParams.get("headSha")?.trim() || undefined;
  const path = parsed.searchParams.get("path")?.trim() || undefined;
  const line = Number.parseInt(parsed.searchParams.get("line") ?? "", 10);
  const startLine = Number.parseInt(parsed.searchParams.get("startLine") ?? "", 10);
  const side = parsed.searchParams.get("side");
  if (prKey.length === 0 || prKey.length > 300 || !/^[a-zA-Z0-9._:/#-]+$/.test(prKey) || prKey.split(/[/:#]/).includes("..")) return null;
  if (session.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(session)) return null;
  if (context != null && (context.length > 6_000 || context.includes("\0"))) return null;
  if (headSha != null && !/^[a-fA-F0-9]{7,64}$/.test(headSha)) return null;
  if (path != null && (path.length > 1_000 || path.includes("\0"))) return null;
  if (path != null && (!Number.isInteger(line) || line < 1 || (side !== "RIGHT" && side !== "LEFT"))) return null;
  if (path == null && (Number.isInteger(line) || Number.isInteger(startLine) || side != null)) return null;
  if (Number.isInteger(startLine) && (startLine < 1 || startLine > line)) return null;
  const target = path == null ? undefined : { path, line, ...(Number.isInteger(startLine) ? { startLine } : {}), side: side as "RIGHT" | "LEFT" };
  return { prKey, session, ...(context == null ? {} : { context }), ...(headSha == null ? {} : { headSha }), ...(target == null ? {} : { target }) };
}

/** Decode a bounded terminal input or resize message. */
export function parsePiTerminalClientMessage(raw: string): PiTerminalClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null || !("type" in parsed)) return null;
  if (parsed.type === "input" && "data" in parsed && typeof parsed.data === "string") {
    return parsed.data.length <= 64_000 ? { type: "input", data: parsed.data } : null;
  }
  if (parsed.type === "resize" && "cols" in parsed && "rows" in parsed) {
    return {
      type: "resize",
      cols: boundedDimension(parsed.cols, DEFAULT_COLS, 1_000),
      rows: boundedDimension(parsed.rows, DEFAULT_ROWS, 500),
    };
  }
  return null;
}

/** Own persistent interactive Pi processes and attach browser terminal peers. */
export function createPiTerminalManager(deps: PiTerminalManagerDeps) {
  const sessions = new Map<string, Promise<TerminalSession>>();
  const piCommand = deps.piCommand ?? resolvePiTerminalCommand();
  const sessionRoot = deps.sessionRoot ?? resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "terminal-sessions");
  async function createSession(request: PiTerminalRequest): Promise<TerminalSession> {
    const cwd = deps.cwdForPr(request.prKey);
    if (cwd == null) throw new Error("Open this pull request before starting its terminal.");
    const key = `${request.prKey}\0${request.session}`;
    const sessionDir = resolve(sessionRoot, safe(request.prKey), safe(request.session));
    await mkdir(sessionDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...(deps.apiUrl == null ? {} : { PI_REVIEW_API_URL: deps.apiUrl }),
      PI_REVIEW_PR_KEY: request.prKey,
      ...(request.headSha == null ? {} : { PI_REVIEW_HEAD_SHA: request.headSha }),
      ...(request.target == null ? {} : { PI_REVIEW_TARGET: JSON.stringify(request.target) }),
    };
    delete env.PI_SESSION_FILE;
    delete env.PI_SESSION_ID;
    const args = ["--session-dir", sessionDir, "--continue", "--name", `Pi Review · ${request.session}`];
    if (deps.extensionPath != null) args.push("--extension", deps.extensionPath);
    args.push("--append-system-prompt", [ghstackWorkspaceInstructions(request.prKey), request.context].filter(Boolean).join("\n\n"));
    const options = { cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, env, name: "xterm-256color" };
    const processHandle = deps.spawn == null
      ? (await import("node-pty")).spawn(piCommand, args, options)
      : deps.spawn(piCommand, args, options);
    const terminalSession: TerminalSession = { process: processHandle, peers: new Set(), buffer: "" };
    processHandle.onData((data) => {
      terminalSession.buffer = `${terminalSession.buffer}${data}`.slice(-MAX_BUFFER_CHARS);
      for (const peer of terminalSession.peers) peer.send({ type: "output", data });
    });
    processHandle.onExit(({ exitCode, signal }) => {
      for (const peer of terminalSession.peers) peer.send({ type: "exit", exitCode, signal: signal ?? 0 });
      terminalSession.peers.clear();
      if (sessions.get(key) != null) sessions.delete(key);
      deps.logger?.info("pi-terminal", "process exited", { prKey: request.prKey, session: request.session, exitCode, signal });
    });
    deps.logger?.info("pi-terminal", "process started", { prKey: request.prKey, session: request.session, cwd, command: piCommand, pid: processHandle.pid });
    return terminalSession;
  }

  async function getSession(request: PiTerminalRequest): Promise<TerminalSession> {
    const key = `${request.prKey}\0${request.session}`;
    const existing = sessions.get(key);
    if (existing != null) return existing;
    const created = createSession(request);
    sessions.set(key, created);
    try {
      return await created;
    } catch (error) {
      if (sessions.get(key) === created) sessions.delete(key);
      throw error;
    }
  }

  async function attach(peer: PiTerminalPeer, request: PiTerminalRequest): Promise<void> {
    let attachedSession: TerminalSession | null = null;
    let closed = false;
    peer.onClose(() => {
      closed = true;
      attachedSession?.peers.delete(peer);
    });
    try {
      const session = await getSession(request);
      if (closed) return;
      attachedSession = session;
      session.peers.add(peer);
      peer.send({ type: "ready", pid: session.process.pid });
      if (session.buffer.length > 0) peer.send({ type: "output", data: session.buffer });
      peer.onMessage((raw) => {
        const message = parsePiTerminalClientMessage(raw);
        if (message?.type === "input") session.process.write(message.data);
        else if (message?.type === "resize") session.process.resize(message.cols, message.rows);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger?.error("pi-terminal", "connection failed", { prKey: request.prKey, session: request.session, error: message });
      peer.send({ type: "error", message });
      peer.close(1011, "Terminal startup failed");
    }
  }

  async function stopSessions(sessionPromises: Promise<TerminalSession>[], reason: string): Promise<void> {
    const settled = await Promise.allSettled(sessionPromises);
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const peer of result.value.peers) peer.close(1001, reason);
      result.value.process.kill();
    }
  }

  async function broadcastDraftReview(prKey: string, draftReview: DraftReview): Promise<void> {
    const matching = [...sessions.entries()].filter(([key]) => key.startsWith(`${prKey}\0`));
    const settled = await Promise.allSettled(matching.map(([, session]) => session));
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const peer of result.value.peers) peer.send({ type: "draftReview", draftReview });
    }
  }

  async function disposePr(prKey: string): Promise<void> {
    const matching = [...sessions.entries()].filter(([key]) => key.startsWith(`${prKey}\0`));
    for (const [key] of matching) sessions.delete(key);
    await stopSessions(matching.map(([, session]) => session), "Pull request closed");
  }

  async function dispose(): Promise<void> {
    const active = [...sessions.values()];
    sessions.clear();
    await stopSessions(active, "Server shutting down");
  }

  return { attach, broadcastDraftReview, dispose, disposePr };
}

export type PiTerminalManager = ReturnType<typeof createPiTerminalManager>;
