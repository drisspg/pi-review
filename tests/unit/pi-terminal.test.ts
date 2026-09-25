import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";

import { createPiTerminalManager, parsePiTerminalClientMessage, parsePiTerminalRequest, resolvePiTerminalCommand, type PiTerminalPeer, type PiTerminalServerMessage } from "../../src/pi-terminal.js";

// Keep the developer's machine-local launcher/model overrides out of these hermetic tests.
process.env.PI_REVIEW_LOCAL_CONFIG = "/nonexistent/.pi-review.local.json";

class FakeProcess {
  pid = 42;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  killSignals: Array<string | undefined> = [];
  pauses = 0;
  resumes = 0;
  dataListener: (data: string) => void = () => undefined;
  exitListener: (event: { exitCode: number; signal?: number }) => void = () => undefined;

  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  pause() { this.pauses += 1; }
  resume() { this.resumes += 1; }
  kill(signal?: string) { this.killSignals.push(signal); this.killed = true; this.exitListener({ exitCode: 0 }); }
  onData(listener: (data: string) => void) { this.dataListener = listener; return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.exitListener = listener; return { dispose() {} }; }
}

class FakePeer implements PiTerminalPeer {
  messages: PiTerminalServerMessage[] = [];
  closed: [number | undefined, string | undefined] | null = null;
  messageListener: (message: string) => void = () => undefined;
  closeListener: () => void = () => undefined;

  send(message: PiTerminalServerMessage) { this.messages.push(message); }
  close(code?: number, reason?: string) { this.closed = [code, reason]; }
  onMessage(listener: (message: string) => void) { this.messageListener = listener; }
  onClose(listener: () => void) { this.closeListener = listener; }
}

async function failingSignalFixture(t: TestContext, options: { idleTimeoutMs?: number; maxSessions?: number; processExitTimeoutMs?: number } = {}) {
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-6-astra" }));
  const root = await mkdtemp(join(tmpdir(), "pi-review-signal-failure-"));
  const fake = new FakeProcess();
  const processes = new Map<number, FakeProcess>();
  const control = { gone: false, denyTerm: false, denyKill: false, denyProbe: false, linger: false };
  const signals: Array<{ pgid: number; signal: NodeJS.Signals | 0 }> = [];
  const errors: Array<{ message: string; data?: Record<string, unknown> }> = [];
  let spawns = 0;
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree", piCommand: "/usr/local/bin/pi", sessionRoot: root,
    processExitTimeoutMs: 30, ...options,
    logger: { info() {}, error(_scope, message, data) { errors.push({ message, data }); } },
    spawn: () => {
      const process = spawns === 0 ? fake : new FakeProcess();
      process.pid = 42 + spawns++;
      processes.set(process.pid, process);
      control.gone = false;
      return process;
    },
    signalProcessGroup(pgid, signal) {
      signals.push({ pgid, signal });
      if (signal === 0) {
        if (control.gone) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
        if (control.denyProbe) throw Object.assign(new Error("probe EPERM"), { code: "EPERM" });
        return;
      }
      if ((signal === "SIGTERM" && control.denyTerm) || (signal === "SIGKILL" && control.denyKill)) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      if (signal === "SIGTERM") {
        if (!control.linger) control.gone = true;
        processes.get(pgid)!.exitListener({ exitCode: 0, signal: 15 });
      }
      if (signal === "SIGKILL" && !control.linger) control.gone = true;
    },
  });
  t.after(async () => {
    control.denyTerm = control.denyKill = control.denyProbe = control.linger = false;
    control.gone = true;
    for (const process of processes.values()) process.exitListener({ exitCode: 0 });
    await new Promise((done) => setImmediate(done));
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const request = { prKey: "github.com/org/repo#1", session: "main" };
  const peer = new FakePeer();
  await manager.attach(peer, request);
  return { root, fake, control, signals, errors, manager, request, peer, spawns: () => spawns };
}

test("exit-callback probe EPERM is contained and blocks replacement until group absence is verified", async (t) => {
  const f = await failingSignalFixture(t);
  f.control.denyKill = f.control.denyProbe = true;
  assert.doesNotThrow(() => f.fake.exitListener({ exitCode: 0, signal: 15 }));
  assert.equal(f.peer.messages.some((message) => message.type === "error"), false, "do not alarm on a possibly transient exit probe");
  await assert.rejects(f.manager.disposePr(f.request.prKey), /EPERM/);
  assert.equal(f.errors[0].data?.pid, 42);
  assert.equal(f.errors[0].data?.pgid, 42);
  assert.equal(f.errors[0].data?.signal, "0");
  await new Promise((done) => setImmediate(done));
  await assert.rejects(f.manager.disposePr(f.request.prKey), /EPERM/);
  const blocked = new FakePeer();
  await f.manager.attach(blocked, f.request);
  assert.equal(blocked.messages.some((message) => message.type === "ready"), false);
  assert.equal(f.spawns(), 1);
  assert.doesNotThrow(() => f.fake.exitListener({ exitCode: 0 }));
  assert.equal(f.signals.filter(({ signal }) => signal !== 0).length, 0, "never signal an exited leader's possibly reused PGID");
  f.control.gone = true;
  await new Promise((done) => setImmediate(done));
  await f.manager.disposePr(f.request.prKey);
});

test("exit callbacks only probe gone groups and never issue SIGKILL or a spurious error", async (t) => {
  const f = await failingSignalFixture(t);
  f.control.denyKill = true;
  f.control.gone = true;
  assert.doesNotThrow(() => f.fake.exitListener({ exitCode: 0 }));
  await f.manager.disposePr(f.request.prKey);
  assert.ok(f.signals.length > 0 && f.signals.every(({ signal }) => signal === 0));
  assert.deepEqual(f.errors, []);
  assert.equal(f.peer.messages.some((message) => message.type === "error"), false);
});

test("leader exit alone does not permit replacement while the group still exists", async (t) => {
  const f = await failingSignalFixture(t);
  f.control.linger = true;
  await assert.rejects(f.manager.disposePr(f.request.prKey), /has not exited/);
  await new Promise((done) => setImmediate(done));
  f.control.gone = true;
  await f.manager.disposePr(f.request.prKey);
  assert.equal(f.signals.filter(({ signal }) => signal === "SIGTERM").length, 1);
  assert.equal(f.signals.filter(({ signal }) => signal === "SIGKILL").length, 0);
});

for (const origin of ["peer", "idle timer"] as const) {
  test(`SIGTERM EPERM from ${origin} is contained and preserves session history`, async (t) => {
    const f = await failingSignalFixture(t, { idleTimeoutMs: 5 });
    const history = join(f.root, "github.com-org-repo-1", "main", "history.jsonl");
    await writeFile(history, "keep history");
    f.control.denyTerm = true;
    if (origin === "peer") {
      assert.doesNotThrow(() => f.peer.messageListener(JSON.stringify({ type: "stop" })));
      assert.ok(f.peer.messages.some((message) => message.type === "error" && /EPERM/.test(message.message)));
      assert.equal(f.peer.closed?.[0], 1011);
    } else { f.peer.closeListener(); await new Promise((done) => setTimeout(done, 20)); }
    await assert.rejects(f.manager.disposePr(f.request.prKey), /EPERM/);
    await assert.rejects(f.manager.deleteSession(f.request.prKey, f.request.session), /EPERM/);
    assert.equal(await readFile(history, "utf8"), "keep history");
    assert.ok(f.errors.some(({ data }) => data?.signal === "SIGTERM"));
  });
}

test("a denied SIGTERM can be retried while the leader has not exited", async (t) => {
  const f = await failingSignalFixture(t);
  f.control.denyTerm = true;
  await assert.rejects(f.manager.disposePr(f.request.prKey), /EPERM/);
  f.control.denyTerm = false;
  await f.manager.disposePr(f.request.prKey);
  assert.equal(f.signals.filter(({ signal }) => signal === "SIGTERM").length, 2);
  assert.equal(f.control.gone, true);
});

test("a named terminal cannot reconnect while its deletion is waiting for group exit", async (t) => {
  const f = await failingSignalFixture(t, { processExitTimeoutMs: 1_000 });
  f.control.linger = true;
  const deletion = f.manager.deleteSession(f.request.prKey, f.request.session);
  await new Promise((done) => setImmediate(done));
  const blocked = new FakePeer();
  await f.manager.attach(blocked, f.request);
  assert.ok(blocked.messages.some((message) => message.type === "error" && /being deleted/.test(message.message)));
  assert.equal(f.spawns(), 1);
  f.control.gone = true;
  await deletion;
  await assert.rejects(access(join(f.root, "github.com-org-repo-1", "main")));
});

test("session-cap cleanup failures prevent an extra PTY from being spawned", async (t) => {
  const f = await failingSignalFixture(t, { maxSessions: 1 });
  f.control.denyTerm = true;
  f.peer.closeListener();
  const blocked = new FakePeer();
  await f.manager.attach(blocked, { ...f.request, session: "second" });
  assert.equal(f.spawns(), 1);
  assert.ok(blocked.messages.some((message) => message.type === "error" && /EPERM/.test(message.message)));
});

test("unverified groups still count toward the terminal cap after their leader exits", async (t) => {
  const f = await failingSignalFixture(t, { maxSessions: 1 });
  f.fake.exitListener({ exitCode: 0 });
  await new Promise((done) => setImmediate(done));
  const blocked = new FakePeer();
  await f.manager.attach(blocked, { prKey: "github.com/org/other#2", session: "main" });
  assert.equal(f.spawns(), 1);
  assert.ok(blocked.messages.some((message) => message.type === "error" && /has not exited/.test(message.message)));
});

test("group signaling uses the captured positive PID, not the mutable PTY getter", async (t) => {
  const f = await failingSignalFixture(t);
  f.fake.pid = 1;
  f.control.gone = true;
  assert.doesNotThrow(() => f.fake.exitListener({ exitCode: 0 }));
  assert.ok(f.signals.every(({ pgid }) => pgid === 42));
  await f.manager.disposePr(f.request.prKey);
});

test("native PTY stop verifies its process group without a post-exit force kill", { timeout: 15_000, skip: process.platform === "win32" }, async (t) => {
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-6-astra" }));
  const root = await mkdtemp(join(tmpdir(), "pi-review-native-stop-"));
  const command = join(root, "fake-pi");
  await writeFile(command, "#!/bin/sh\ntrap 'exit 0' TERM INT HUP\nprintf 'fixture ready\\n'\nsleep 2\n");
  await chmod(command, 0o755);
  const manager = createPiTerminalManager({ cwdForPr: () => root, piCommand: command, sessionRoot: join(root, "sessions") });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  const peer = new FakePeer();
  await manager.attach(peer, { prKey: "github.com/fixture/repo#1", session: "main" });
  const deadline = Date.now() + 3_000;
  while (!peer.messages.some((message) => message.type === "output" && message.data.includes("fixture ready")) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.ok(peer.messages.some((message) => message.type === "output" && message.data.includes("fixture ready")));
  await manager.disposePr("github.com/fixture/repo#1");
  assert.equal(peer.messages.some((message) => message.type === "error"), false);
});

test("validates Pi terminal connection URLs", () => {
  assert.deepEqual(parsePiTerminalRequest("/api/pi/terminal?prKey=github.com%2Forg%2Frepo%231&session=main&context=Review+line+7"), { prKey: "github.com/org/repo#1", session: "main", context: "Review line 7" });
  assert.deepEqual(parsePiTerminalRequest("/api/pi/terminal?prKey=github.com%2Forg%2Frepo%231&session=line&headSha=abcdef1234567&path=src%2Fa.ts&line=9&startLine=8&side=RIGHT"), { prKey: "github.com/org/repo#1", session: "line", headSha: "abcdef1234567", target: { path: "src/a.ts", line: 9, startLine: 8, side: "RIGHT" } });
  assert.equal(parsePiTerminalRequest("/api/pi/terminal?prKey=github.com%2Forg%2Frepo%231&path=src%2Fa.ts&line=9"), null);
  assert.equal(parsePiTerminalRequest("/api/pi/terminal?session=main"), null);
  assert.equal(parsePiTerminalRequest("/api/pi/terminal?prKey=../../etc&session=main"), null);
  assert.equal(parsePiTerminalRequest("/api/other?prKey=github.com/org/repo%231"), null);
});

test("bounds terminal resize and input messages", () => {
  assert.deepEqual(parsePiTerminalClientMessage(JSON.stringify({ type: "resize", cols: 0, rows: 900 })), { type: "resize", cols: 2, rows: 500 });
  assert.deepEqual(parsePiTerminalClientMessage(JSON.stringify({ type: "input", data: "hello" })), { type: "input", data: "hello" });
  assert.deepEqual(parsePiTerminalClientMessage(JSON.stringify({ type: "stop" })), { type: "stop" });
  assert.deepEqual(parsePiTerminalClientMessage(JSON.stringify({ type: "ack", chars: 32_768 })), { type: "ack", chars: 32_768 });
  assert.equal(parsePiTerminalClientMessage(JSON.stringify({ type: "ack", chars: -5 })), null);
  assert.equal(parsePiTerminalClientMessage(JSON.stringify({ type: "ack", chars: 1.5 })), null);
  assert.equal(parsePiTerminalClientMessage("not-json"), null);
  assert.equal(parsePiTerminalClientMessage(JSON.stringify({ type: "input", data: "x".repeat(64_001) })), null);
});

test("resolves Pi outside npm-injected project binaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-command-"));
  const projectBin = join(root, "project", "node_modules", ".bin");
  const userBin = join(root, "user-bin");
  const executable = process.platform === "win32" ? "pi.cmd" : "pi";
  try {
    await Promise.all([mkdir(projectBin, { recursive: true }), mkdir(userBin, { recursive: true })]);
    await Promise.all([
      writeFile(join(projectBin, executable), "#!/bin/sh\n"),
      writeFile(join(userBin, executable), "#!/bin/sh\n"),
    ]);
    await Promise.all([chmod(join(projectBin, executable), 0o755), chmod(join(userBin, executable), 0o755)]);
    assert.equal(resolvePiTerminalCommand([projectBin, userBin].join(delimiter)), join(userBin, executable));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attaches a peer to one persistent Pi PTY", async (t) => {
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-6-astra" }));
  const process = new FakeProcess();
  const spawns: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const manager = createPiTerminalManager({
    apiUrl: "http://127.0.0.1:43133",
    cwdForPr: () => "/tmp/pr-worktree",
    extensionPath: "/tmp/pi-review-extension.ts",
    piCommand: "/usr/local/bin/pi",
    sessionRoot: "/tmp/pi-review-terminal-test",
    spawn: (command, args, options) => {
      spawns.push({ command, args, cwd: options.cwd, env: options.env });
      return process as never;
    },
  });
  const first = new FakePeer();
  await manager.attach(first, { prKey: "github.com/org/repo#1", session: "main", headSha: "abcdef1234567", target: { path: "src/a.ts", line: 9, side: "RIGHT" }, context: "Review line 7" });
  assert.deepEqual(first.messages, [{ type: "ready", pid: 42 }]);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, "/usr/local/bin/pi");
  assert.equal(spawns[0].cwd, "/tmp/pr-worktree");
  assert.deepEqual(spawns[0].args.slice(0, -1), ["--session-dir", "/tmp/pi-review-terminal-test/github.com-org-repo-1/main", "--continue", "--name", "Pi Review · main", "--provider", "openai", "--model", "gpt-6-astra", "--extension", "/tmp/pi-review-extension.ts", "--append-system-prompt"]);
  assert.match(spawns[0].args.at(-1) ?? "", /gh pr view <number-or-url>.*gh pr diff <number-or-url>/);
  assert.match(spawns[0].args.at(-1) ?? "", /Review line 7$/);
  assert.equal(spawns[0].env.PI_REVIEW_API_URL, "http://127.0.0.1:43133");
  assert.equal(spawns[0].env.PI_REVIEW_PR_KEY, "github.com/org/repo#1");
  assert.equal(spawns[0].env.PI_REVIEW_HEAD_SHA, "abcdef1234567");
  assert.equal(spawns[0].env.PI_REVIEW_TARGET, JSON.stringify({ path: "src/a.ts", line: 9, side: "RIGHT" }));
  assert.deepEqual(JSON.parse(spawns[0].env.PI_REVIEW_WORKSPACE_CONTEXT!), { prKey: "github.com/org/repo#1", root: "/tmp/pr-worktree", headSha: "abcdef1234567", scope: "main", target: { path: "src/a.ts", line: 9, side: "RIGHT" } });

  process.dataListener("native output");
  assert.deepEqual(first.messages.at(-1), { type: "output", data: "native output" });
  first.messageListener(JSON.stringify({ type: "input", data: "question\r" }));
  first.messageListener(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  assert.deepEqual(process.writes, ["question\r"]);
  assert.deepEqual(process.resizes, [[120, 40]]);

  const second = new FakePeer();
  await manager.attach(second, { prKey: "github.com/org/repo#1", session: "main" });
  assert.equal(spawns.length, 1);
  assert.deepEqual(second.messages, [{ type: "ready", pid: 42 }, { type: "output", data: "native output" }]);

  const draftReview = { prKey: "github.com/org/repo#1", headSha: "abcdef1234567", event: "COMMENT" as const, body: "", comments: [], updatedAt: "now" };
  await manager.broadcastDraftReview("github.com/org/repo#1", draftReview);
  assert.deepEqual(first.messages.at(-1), { type: "draftReview", draftReview });
  assert.deepEqual(second.messages.at(-1), { type: "draftReview", draftReview });

  await manager.disposePr("github.com/org/repo#1");
  assert.equal(process.killed, true);
  assert.deepEqual(process.killSignals, ["SIGTERM"]);
  assert.deepEqual(first.closed, [1001, "Pull request closed"]);
});

test("stops an explicitly closed terminal and resumes it from the persisted session", async () => {
  const processes: FakeProcess[] = [];
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    piCommand: "/usr/local/bin/pi",
    sessionRoot: "/tmp/pi-review-terminal-test",
    spawn: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process as never;
    },
  });
  const first = new FakePeer();
  await manager.attach(first, { prKey: "github.com/org/repo#1", session: "line-1" });
  first.messageListener(JSON.stringify({ type: "stop" }));
  assert.equal(processes[0].killed, true);
  assert.deepEqual(first.closed, [1001, "Terminal stopped"]);

  await manager.attach(new FakePeer(), { prKey: "github.com/org/repo#1", session: "line-1" });
  assert.equal(processes.length, 2);
  processes[0].exitListener({ exitCode: 0 });
  await manager.attach(new FakePeer(), { prKey: "github.com/org/repo#1", session: "line-1" });
  assert.equal(processes.length, 2);
  await manager.dispose();
});

test("deletes active terminals and their persisted session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-terminal-delete-"));
  const process = new FakeProcess();
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    piCommand: "/usr/local/bin/pi",
    sessionRoot: root,
    spawn: () => process as never,
  });
  const peer = new FakePeer();
  try {
    await manager.attach(peer, { prKey: "github.com/org/repo#1", session: "inline-1" });
    const sessionDir = join(root, "github.com-org-repo-1", "inline-1");
    await writeFile(join(sessionDir, "state.json"), "{}");

    await manager.deleteSession("github.com/org/repo#1", "inline-1");
    assert.equal(process.killed, true);
    assert.deepEqual(peer.closed, [1001, "Terminal deleted"]);
    await assert.rejects(() => access(sessionDir));
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("stops detached terminals after the idle timeout", async () => {
  const process = new FakeProcess();
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    idleTimeoutMs: 5,
    piCommand: "/usr/local/bin/pi",
    sessionRoot: "/tmp/pi-review-terminal-test",
    spawn: () => process as never,
  });
  const peer = new FakePeer();
  await manager.attach(peer, { prKey: "github.com/org/repo#1", session: "line-1" });
  peer.closeListener();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(process.killed, true);
});

test("evicts the oldest detached terminal at the session cap", async () => {
  const processes: FakeProcess[] = [];
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    idleTimeoutMs: 60_000,
    maxSessions: 2,
    piCommand: "/usr/local/bin/pi",
    sessionRoot: "/tmp/pi-review-terminal-test",
    spawn: () => {
      const process = new FakeProcess();
      processes.push(process);
      return process as never;
    },
  });
  const first = new FakePeer();
  const second = new FakePeer();
  await manager.attach(first, { prKey: "github.com/org/repo#1", session: "line-1" });
  first.closeListener();
  await manager.attach(second, { prKey: "github.com/org/repo#1", session: "line-2" });
  second.closeListener();
  await manager.attach(new FakePeer(), { prKey: "github.com/org/repo#1", session: "line-3" });
  assert.equal(processes.length, 3);
  assert.equal(processes[0].killed, true);
  await manager.dispose();
});

test("reports a missing PR checkout without spawning", async () => {
  const peer = new FakePeer();
  const manager = createPiTerminalManager({ cwdForPr: () => null, sessionRoot: "/tmp/pi-review-terminal-test" });
  await manager.attach(peer, { prKey: "github.com/org/repo#1", session: "main" });
  assert.deepEqual(peer.messages, [{ type: "error", message: "Open this pull request before starting its terminal." }]);
  assert.deepEqual(peer.closed, [1011, "Terminal startup failed"]);
});

test("pauses the pty when a peer falls behind and resumes on acks", async () => {
  const fake = new FakeProcess();
  const manager = createPiTerminalManager({ cwdForPr: () => "/tmp/pr-worktree", piCommand: "pi", sessionRoot: "/tmp/pi-review-terminal-test", spawn: () => fake });
  const peer = new FakePeer();
  await manager.attach(peer, { prKey: "github.com/org/repo#1", session: "flow" });

  fake.dataListener("x".repeat(400_000));
  assert.equal(fake.pauses, 0);
  fake.dataListener("y".repeat(200_000));
  assert.equal(fake.pauses, 1);

  peer.messageListener(JSON.stringify({ type: "ack", chars: 400_000 }));
  assert.equal(fake.resumes, 0);
  peer.messageListener(JSON.stringify({ type: "ack", chars: 100_000 }));
  assert.equal(fake.resumes, 1);
  await manager.dispose();
});

test("a disconnecting slow peer releases flow control", async () => {
  const fake = new FakeProcess();
  const manager = createPiTerminalManager({ cwdForPr: () => "/tmp/pr-worktree", piCommand: "pi", sessionRoot: "/tmp/pi-review-terminal-test", spawn: () => fake });
  const peer = new FakePeer();
  await manager.attach(peer, { prKey: "github.com/org/repo#1", session: "flow-close" });

  fake.dataListener("x".repeat(600_000));
  assert.equal(fake.pauses, 1);

  peer.closeListener();
  assert.equal(fake.resumes, 1);
  await manager.dispose();
});

test("concurrent attaches share one PTY and disposal invalidates pending startup", async () => {
  let spawns = 0;
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    sessionRoot: "/tmp/pi-review-terminal-lifecycle-test",
    spawn: () => { spawns += 1; return new FakeProcess() as never; },
  });
  const request = { prKey: "github.com/org/repo#1", session: "main" };
  await Promise.all([manager.attach(new FakePeer(), request), manager.attach(new FakePeer(), request)]);
  assert.equal(spawns, 1);
  await manager.disposePr(request.prKey);
  const peer = new FakePeer();
  const attaching = manager.attach(peer, request);
  await manager.disposePr(request.prKey);
  await attaching;
  assert.equal(spawns, 1);
  assert.equal(peer.messages.some((message) => message.type === "ready"), false);
  await manager.dispose();
});

test("PTY reuse checks revision and rejects a stale browser revision", async () => {
  const processes: FakeProcess[] = [];
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    sessionRoot: "/tmp/pi-review-terminal-revision-test",
    spawn: () => { const process = new FakeProcess(); processes.push(process); return process as never; },
  });
  const request = { prKey: "github.com/org/repo#1", session: "main" };
  await manager.attach(new FakePeer(), { ...request, headSha: "aaaaaaa" });
  await manager.attach(new FakePeer(), { ...request, headSha: "bbbbbbb" });
  assert.equal(processes.length, 2);
  assert.equal(processes[0].killed, true);
  await manager.dispose();
  const validated = createPiTerminalManager({ cwdForPr: () => "/tmp/pr-worktree", headShaForPr: () => "bbbbbbb", spawn: () => { throw new Error("must not spawn"); } });
  const stale = new FakePeer();
  await validated.attach(stale, { ...request, headSha: "aaaaaaa" });
  assert.ok(stale.messages.some((message) => message.type === "error" && /stale/.test(message.message)));
  await validated.dispose();
});

test("a terminal that exits after a shutdown timeout releases the transition barrier", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const process = new FakeProcess();
  process.kill = () => { process.killed = true; };
  const manager = createPiTerminalManager({ cwdForPr: () => "/tmp/pr-worktree", sessionRoot: "/tmp/pi-review-terminal-late-exit-test", spawn: () => process as never });
  const request = { prKey: "github.com/org/repo#1", session: "main" };
  await manager.attach(new FakePeer(), request);
  const disposal = manager.disposePr(request.prKey);
  const rejected = assert.rejects(disposal, /did not exit/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await rejected;
  const blocked = new FakePeer();
  await manager.attach(blocked, request);
  assert.equal(blocked.messages.some((message) => message.type === "ready"), false);
  process.exitListener({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  await manager.disposePr(request.prKey);
  await manager.dispose();
});

test("PR disposal waits for PTY exit before permitting checkout replacement", async () => {
  const process = new FakeProcess();
  process.kill = () => { process.killed = true; };
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    sessionRoot: "/tmp/pi-review-terminal-exit-test",
    spawn: () => process as never,
  });
  const request = { prKey: "github.com/org/repo#1", session: "main" };
  await manager.attach(new FakePeer(), request);
  let disposed = false;
  const disposing = manager.disposePr(request.prKey).then(() => { disposed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(process.killed, true);
  assert.equal(disposed, false);
  const reconnect = new FakePeer();
  await manager.attach(reconnect, request);
  assert.equal(reconnect.messages.some((message) => message.type === "ready"), false);
  process.exitListener({ exitCode: 0 });
  await disposing;
  assert.equal(disposed, true);
  await manager.dispose();
});
