/** Own interactive Pi processes behind a bounded browser-terminal protocol. */

import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import type { IPty } from "node-pty";

import { ghstackWorkspaceInstructions } from "./ghstack-guidance.js";
import { reviewSessionRoot } from "./storage-paths.js";
import { piLaunch, piModelArgs } from "./pi-launch.js";
import { reviewWorkspaceEnvironment } from "./pi-review-workspace.js";
export { resolvePiTerminalCommand } from "./pi-launch.js";
import type { DraftReview } from "./types.js";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_BUFFER_CHARS = 1_000_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_SESSIONS = 15;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
// Ack-based flow control (the xterm.js-recommended pattern): pause the pty when
// the slowest attached browser falls too far behind, so a burst (e.g. catting a
// large file) cannot flood the WebSocket or xterm's parse queue.
const FLOW_PAUSE_CHARS = 512_000;
const FLOW_RESUME_CHARS = 128_000;

export type PiTerminalServerMessage =
  | { type: "ready"; pid: number }
  | { type: "output"; data: string }
  | { type: "draftReview"; draftReview: DraftReview }
  | { type: "exit"; exitCode: number; signal: number }
  | { type: "error"; message: string };

export type PiTerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; chars: number }
  | { type: "stop" };

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

type TerminalProcess = Pick<IPty, "kill" | "pause" | "pid" | "resize" | "resume" | "write"> & {
  onData: IPty["onData"];
  onExit: IPty["onExit"];
};

type TerminalSession = {
  key: string;
  pid: number;
  exitObserved: boolean;
  signalGroup?: (signal: NodeJS.Signals | 0) => void;
  headSha?: string;
  stopped: boolean;
  exited: Promise<void>;
  process: TerminalProcess;
  peers: Set<PiTerminalPeer>;
  buffer: string;
  idleTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  paused: boolean;
  unackedChars: Map<PiTerminalPeer, number>;
};

export type PiTerminalManagerDeps = {
  cwdForPr: (prKey: string) => string | null;
  headShaForPr?: (prKey: string) => string | null;
  logger?: {
    error: (scope: string, message: string, data?: Record<string, unknown>) => void;
    info: (scope: string, message: string, data?: Record<string, unknown>) => void;
  };
  apiUrl?: string;
  extensionPath?: string;
  piCommand?: string;
  sessionRoot?: string;
  idleTimeoutMs?: number;
  maxSessions?: number;
  processExitTimeoutMs?: number;
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals | 0) => void;
  spawn?: (command: string, args: string[], options: { cols: number; cwd: string; env: NodeJS.ProcessEnv; name: string; rows: number }) => TerminalProcess;
};

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function boundedDimension(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(max, Math.round(value)));
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
  if (parsed.type === "ack" && "chars" in parsed && typeof parsed.chars === "number" && Number.isInteger(parsed.chars) && parsed.chars > 0) {
    return { type: "ack", chars: Math.min(parsed.chars, 1_000_000_000) };
  }
  return parsed.type === "stop" ? { type: "stop" } : null;
}

/** Own persistent interactive Pi processes and attach browser terminal peers. */
export function createPiTerminalManager(deps: PiTerminalManagerDeps) {
  const sessions = new Map<string, Promise<TerminalSession>>();
  const generations = new Map<string, number>();
  const disposals = new Map<string, Promise<void>>();
  const deletions = new Map<string, Promise<void>>();
  // Keep failed cleanup independent of session/disposal promise eviction. A retry must never
  // forget an unverified process group merely because the PTY leader already exited.
  const terminationFailures = new Map<string, { session: TerminalSession; error: Error; signal?: string; reported?: boolean }>();
  const sessionRoot = deps.sessionRoot ?? resolve(reviewSessionRoot(), "terminal-sessions");
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const processExitTimeoutMs = deps.processExitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS;

  /** Pause the pty while the slowest attached browser is too far behind; resume once it catches up. */
  function updateFlowControl(session: TerminalSession): void {
    const maxUnacked = Math.max(0, ...session.unackedChars.values());
    if (!session.paused && maxUnacked > FLOW_PAUSE_CHARS) {
      session.paused = true;
      session.process.pause();
    } else if (session.paused && maxUnacked < FLOW_RESUME_CHARS) {
      session.paused = false;
      session.process.resume();
    }
  }

  function clearFailure(session: TerminalSession): void {
    if (terminationFailures.get(session.key)?.session === session) terminationFailures.delete(session.key);
  }

  function recordSignalFailure(session: TerminalSession, signal: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`Pi terminal ${session.pid} cleanup failed (${signal}: ${detail}); checkout replacement is unsafe until its exit is verified.`, { cause });
    terminationFailures.set(session.key, { session, error, signal, reported: true });
    const [prKey, name] = session.key.split("\0");
    deps.logger?.error("pi-terminal", "terminal signal failed", { prKey, session: name, pid: session.pid, pgid: session.signalGroup == null ? undefined : session.pid, signal, error: detail });
    for (const peer of session.peers) peer.send({ type: "error", message: error.message });
  }

  function groupExitFailure(session: TerminalSession): Error | undefined {
    if (!session.exitObserved) return new Error(`Pi terminal ${session.pid} has not exited; checkout replacement is unsafe.`);
    if (session.signalGroup == null) return undefined;
    try { session.signalGroup(0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
      return new Error(`Cannot verify exit of Pi terminal process group ${session.pid}: ${error instanceof Error ? error.message : String(error)}; checkout replacement is unsafe.`, { cause: error });
    }
    return new Error(`Pi terminal process group ${session.pid} has not exited; checkout replacement is unsafe.`);
  }

  function cleanupFailure(session: TerminalSession): Error | undefined {
    const failure = terminationFailures.get(session.key);
    if (failure?.session !== session) return undefined;
    if (groupExitFailure(session) == null) { clearFailure(session); return undefined; }
    return failure.error;
  }

  function stopSession(session: TerminalSession, reason: string): void {
    const previousFailure = terminationFailures.get(session.key);
    const retryDeniedStop = !session.exitObserved && previousFailure?.session === session && previousFailure.signal === "SIGTERM";
    if (session.stopped && !retryDeniedStop) return;
    session.stopped = true;
    if (retryDeniedStop) clearFailure(session);
    if (session.idleTimer != null) clearTimeout(session.idleTimer);
    const peers = [...session.peers];
    // Auth launchers may ignore SIGHUP; SIGTERM lets them forward shutdown to Pi.
    try { session.process.kill("SIGTERM"); } catch (error) { recordSignalFailure(session, "SIGTERM", error); }
    const failed = terminationFailures.get(session.key)?.session === session;
    for (const peer of peers) peer.close(failed ? 1011 : 1001, failed ? "Terminal cleanup failed" : reason);
    session.peers.clear();
  }

  function scheduleIdleStop(session: TerminalSession): void {
    if (session.idleTimer != null) clearTimeout(session.idleTimer);
    if (session.stopped || session.peers.size > 0) return;
    session.idleTimer = setTimeout(() => stopSession(session, "Terminal stopped after being inactive"), idleTimeoutMs);
  }

  async function enforceSessionLimit(startingKey: string): Promise<void> {
    const others = new Map([...sessions.entries()].filter(([key]) => key !== startingKey));
    for (const [key, failure] of terminationFailures) {
      if (key !== startingKey && !others.has(key)) others.set(key, Promise.resolve(failure.session));
    }
    if (others.size < maxSessions) return;
    const settled = await Promise.all([...others].map(async ([key, session]) => [key, await session] as const));
    const candidate = settled.filter(([, session]) => session.peers.size === 0).sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt)[0];
    if (candidate == null) throw new Error(`Pi Review already has ${maxSessions} active terminals. Collapse or stop one before opening another.`);
    await stopSessions([Promise.resolve(candidate[1])], "Terminal stopped to enforce the session limit");
  }

  async function createSession(request: PiTerminalRequest, generation: number): Promise<TerminalSession> {
    const cwd = deps.cwdForPr(request.prKey);
    if (cwd == null) throw new Error("Open this pull request before starting its terminal.");
    const key = `${request.prKey}\0${request.session}`;
    const sessionDir = resolve(sessionRoot, safe(request.prKey), safe(request.session));
    await mkdir(sessionDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...reviewWorkspaceEnvironment({ prKey: request.prKey, root: cwd, headSha: request.headSha, scope: request.session, target: request.target }),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      ...(deps.apiUrl == null ? {} : { PI_REVIEW_API_URL: deps.apiUrl }),
      PI_REVIEW_PR_KEY: request.prKey,
      ...(request.headSha == null ? {} : { PI_REVIEW_HEAD_SHA: request.headSha }),
      ...(request.target == null ? {} : { PI_REVIEW_TARGET: JSON.stringify(request.target) }),
    };
    if (request.headSha == null) delete env.PI_REVIEW_HEAD_SHA;
    if (request.target == null) delete env.PI_REVIEW_TARGET;
    delete env.PI_SESSION_FILE;
    delete env.PI_SESSION_ID;
    const args = ["--session-dir", sessionDir, "--continue", "--name", `Pi Review · ${request.session}`, ...piModelArgs(cwd)];
    if (deps.extensionPath != null) args.push("--extension", deps.extensionPath);
    args.push("--append-system-prompt", [ghstackWorkspaceInstructions(request.prKey), request.context].filter(Boolean).join("\n\n"));
    const launch = piLaunch(args, { ...env, ...(deps.piCommand == null ? {} : { PI_REVIEW_PI_COMMAND: deps.piCommand }) });
    const options = { cwd, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, env: launch.env, name: "xterm-256color" };
    const spawn = deps.spawn ?? (await import("node-pty")).spawn;
    if ((generations.get(request.prKey) ?? 0) !== generation || deps.cwdForPr(request.prKey) !== cwd || deletions.has(key)) throw new Error("Pull request terminal invalidated.");
    const processHandle = spawn(launch.command, launch.args, options);
    const signalProcessGroup = deps.signalProcessGroup ?? (deps.spawn == null && process.platform !== "win32" ? (pgid: number, signal: NodeJS.Signals | 0) => { process.kill(-pgid, signal); } : undefined);
    const pgid = processHandle.pid;
    const signalGroup = signalProcessGroup == null ? undefined : (signal: NodeJS.Signals | 0) => {
      if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`Invalid terminal process group ${pgid}`);
      signalProcessGroup(pgid, signal);
    };
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const terminalSession: TerminalSession = { key, pid: pgid, exitObserved: false, signalGroup, exited, headSha: request.headSha, stopped: false, process: processHandle, peers: new Set(), buffer: "", idleTimer: null, lastActivityAt: Date.now(), paused: false, unackedChars: new Map() };
    if (signalGroup != null) {
      processHandle.kill = (signal = "SIGTERM") => {
        // After reaping, the numeric PGID can be reused. Only read-only probes are safe then.
        if (terminalSession.exitObserved) return;
        try { signalGroup(signal as NodeJS.Signals); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
    }
    processHandle.onData((data) => {
      terminalSession.lastActivityAt = Date.now();
      terminalSession.buffer = `${terminalSession.buffer}${data}`.slice(-MAX_BUFFER_CHARS);
      for (const peer of terminalSession.peers) {
        peer.send({ type: "output", data });
        terminalSession.unackedChars.set(peer, (terminalSession.unackedChars.get(peer) ?? 0) + data.length);
      }
      updateFlowControl(terminalSession);
    });
    processHandle.onExit(({ exitCode, signal }) => {
      if (terminalSession.exitObserved) return;
      terminalSession.stopped = true;
      terminalSession.exitObserved = true;
      const failure = groupExitFailure(terminalSession);
      if (failure == null) clearFailure(terminalSession);
      else if (terminationFailures.get(key)?.session !== terminalSession) terminationFailures.set(key, { session: terminalSession, error: failure, signal: "0" });
      resolveExit();
      for (const peer of terminalSession.peers) peer.send({ type: "exit", exitCode, signal: signal ?? 0 });
      terminalSession.peers.clear();
      if (terminalSession.idleTimer != null) clearTimeout(terminalSession.idleTimer);
      const sessionPromise = sessions.get(key);
      if (sessionPromise != null) void sessionPromise.then((current) => {
        if (current === terminalSession && sessions.get(key) === sessionPromise) sessions.delete(key);
      }).catch(() => undefined);
      deps.logger?.info("pi-terminal", "process exited", { prKey: request.prKey, session: request.session, pid: pgid, exitCode, signal, cleanupVerified: terminationFailures.get(key)?.session !== terminalSession });
    });
    deps.logger?.info("pi-terminal", "process started", { prKey: request.prKey, session: request.session, cwd, command: launch.command, pid: processHandle.pid });
    return terminalSession;
  }

  async function getSession(request: PiTerminalRequest): Promise<TerminalSession> {
    if (disposals.has(request.prKey)) throw new Error("Pull request terminal is being disposed.");
    const key = `${request.prKey}\0${request.session}`;
    if (deletions.has(key)) throw new Error("Pull request terminal is being deleted.");
    const generation = generations.get(request.prKey) ?? 0;
    const headSha = deps.headShaForPr?.(request.prKey);
    if (deps.cwdForPr(request.prKey) == null) throw new Error("Open this pull request before starting its terminal.");
    if (headSha != null && request.headSha != null && headSha !== request.headSha) throw new Error("Pull request terminal revision is stale.");
    request = { ...request, headSha: headSha ?? request.headSha };
    const failed = [...terminationFailures.values()].filter(({ session }) => session.key.startsWith(`${request.prKey}\0`));
    if (failed.length > 0) await stopSessions(failed.map(({ session }) => Promise.resolve(session)), "Previous terminal cleanup");
    if ((generations.get(request.prKey) ?? 0) !== generation || disposals.has(request.prKey) || deletions.has(key)) throw new Error("Pull request terminal invalidated.");
    const existing = sessions.get(key);
    const created = (async () => {
      if (existing != null) {
        const session = await existing;
        if (!session.stopped && (request.headSha == null || session.headSha === request.headSha)) return session;
        await stopSessions([existing], "Pull request revision changed");
      } else {
        // The startup promise already occupies a slot; exclude it from limit enforcement.
        await enforceSessionLimit(key);
      }
      if ((generations.get(request.prKey) ?? 0) !== generation) throw new Error("Pull request terminal invalidated.");
      return createSession(request, generation);
    })();
    sessions.set(key, created);
    try {
      return await created;
    } catch (error) {
      if (sessions.get(key) === created) sessions.delete(key);
      throw error;
    }
  }

  async function attach(peer: PiTerminalPeer, request: PiTerminalRequest): Promise<void> {
    const generation = generations.get(request.prKey) ?? 0;
    let attachedSession: TerminalSession | null = null;
    let closed = false;
    peer.onClose(() => {
      closed = true;
      if (attachedSession == null) return;
      attachedSession.peers.delete(peer);
      attachedSession.unackedChars.delete(peer);
      updateFlowControl(attachedSession);
      attachedSession.lastActivityAt = Date.now();
      scheduleIdleStop(attachedSession);
    });
    try {
      const session = await getSession(request);
      if (session.stopped || (generations.get(request.prKey) ?? 0) !== generation) throw new Error("Pull request terminal invalidated.");
      if (closed) {
        scheduleIdleStop(session);
        return;
      }
      attachedSession = session;
      session.peers.add(peer);
      session.lastActivityAt = Date.now();
      if (session.idleTimer != null) clearTimeout(session.idleTimer);
      session.idleTimer = null;
      peer.send({ type: "ready", pid: session.process.pid });
      if (session.buffer.length > 0) {
        peer.send({ type: "output", data: session.buffer });
        session.unackedChars.set(peer, session.buffer.length);
        updateFlowControl(session);
      }
      peer.onMessage((raw) => {
        if (session.stopped) return;
        const message = parsePiTerminalClientMessage(raw);
        if (message == null) return;
        session.lastActivityAt = Date.now();
        if (message.type === "input") session.process.write(message.data);
        else if (message.type === "resize") session.process.resize(message.cols, message.rows);
        else if (message.type === "ack") {
          session.unackedChars.set(peer, Math.max(0, (session.unackedChars.get(peer) ?? 0) - message.chars));
          updateFlowControl(session);
        } else stopSession(session, "Terminal stopped");
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
    await Promise.all(settled.map(async (result) => {
      if (result.status !== "fulfilled") return;
      const session = result.value;
      stopSession(session, reason);
      const initialFailure = cleanupFailure(session);
      if (initialFailure != null && !session.exitObserved) throw initialFailure;
      // A leader exit or successful signal is not proof that its process group is gone.
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([session.exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Pi terminal ${session.pid} did not exit; checkout replacement is unsafe.`)), processExitTimeoutMs);
        })]);
        clearTimeout(timer);
        const deadline = performance.now() + processExitTimeoutMs;
        let failure: Error | undefined;
        while ((failure = cleanupFailure(session)) != null) {
          if (performance.now() >= deadline) throw failure;
          // After the leader exits, only probe; never re-signal a possibly reused PGID.
          await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now()))));
        }
      } catch (error) {
        let failure = terminationFailures.get(session.key);
        if (failure == null || failure.session !== session) {
          failure = { session, error: error instanceof Error ? error : new Error(String(error)) };
          terminationFailures.set(session.key, failure);
        }
        if (!failure.reported) {
          failure.reported = true;
          const [prKey, name] = session.key.split("\0");
          deps.logger?.error("pi-terminal", "terminal cleanup unverified", { prKey, session: name, pid: session.pid, pgid: session.signalGroup == null ? undefined : session.pid, signal: failure.signal, error: failure.error.message });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  async function broadcastDraftReview(prKey: string, draftReview: DraftReview): Promise<void> {
    const matching = [...sessions.entries()].filter(([key]) => key.startsWith(`${prKey}\0`));
    const settled = await Promise.allSettled(matching.map(([, session]) => session));
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const peer of result.value.peers) peer.send({ type: "draftReview", draftReview });
    }
  }

  function deleteSession(prKey: string, sessionName: string): Promise<void> {
    const key = `${prKey}\0${sessionName}`;
    const existing = deletions.get(key);
    if (existing != null) return existing;
    const failed = terminationFailures.get(key)?.session;
    const pending = sessions.get(key) ?? (failed == null ? undefined : Promise.resolve(failed));
    const deletion = (async () => {
      if (pending != null) await stopSessions([pending], "Terminal deleted");
      if (sessions.get(key) === pending) sessions.delete(key);
      await rm(resolve(sessionRoot, safe(prKey), safe(sessionName)), { recursive: true, force: true });
    })();
    deletions.set(key, deletion);
    void deletion.finally(() => { if (deletions.get(key) === deletion) deletions.delete(key); }).catch(() => undefined);
    return deletion;
  }

  function disposePr(prKey: string): Promise<void> {
    generations.set(prKey, (generations.get(prKey) ?? 0) + 1);
    const existing = disposals.get(prKey);
    if (existing != null) return existing;
    const matching = new Map([...sessions.entries()].filter(([key]) => key.startsWith(`${prKey}\0`)));
    for (const [key, failure] of terminationFailures) {
      if (key.startsWith(`${prKey}\0`) && !matching.has(key)) matching.set(key, Promise.resolve(failure.session));
    }
    for (const key of matching.keys()) sessions.delete(key);
    const disposal = stopSessions([...matching.values()], "Pull request closed");
    disposals.set(prKey, disposal);
    // Only the in-flight request ends here. Unsafe sessions remain in terminationFailures,
    // including live leaders whose denied SIGTERM may be retried by a later request.
    const release = () => { if (disposals.get(prKey) === disposal) disposals.delete(prKey); };
    void disposal.then(release, release);
    return disposal;
  }

  async function dispose(): Promise<void> {
    const keys = new Set([...disposals.keys(), ...[...sessions.keys(), ...terminationFailures.keys(), ...deletions.keys()].map((key) => key.split("\0")[0])]);
    await Promise.all([...keys].map(disposePr));
    await Promise.all(deletions.values());
  }

  return { attach, broadcastDraftReview, deleteSession, dispose, disposePr };
}

export type PiTerminalManager = ReturnType<typeof createPiTerminalManager>;
