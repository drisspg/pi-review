import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { createPiTerminalManager, parsePiTerminalClientMessage, parsePiTerminalRequest, resolvePiTerminalCommand, type PiTerminalPeer, type PiTerminalServerMessage } from "../../src/pi-terminal.js";

class FakeProcess {
  pid = 42;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  pauses = 0;
  resumes = 0;
  dataListener: (data: string) => void = () => undefined;
  exitListener: (event: { exitCode: number; signal?: number }) => void = () => undefined;

  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  pause() { this.pauses += 1; }
  resume() { this.resumes += 1; }
  kill() { this.killed = true; }
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

test("attaches a peer to one persistent Pi PTY", async () => {
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
  assert.deepEqual(spawns[0].args.slice(0, -1), ["--session-dir", "/tmp/pi-review-terminal-test/github.com-org-repo-1/main", "--continue", "--name", "Pi Review · main", "--extension", "/tmp/pi-review-extension.ts", "--append-system-prompt"]);
  assert.match(spawns[0].args.at(-1) ?? "", /gh pr view <number-or-url>.*gh pr diff <number-or-url>/);
  assert.match(spawns[0].args.at(-1) ?? "", /Review line 7$/);
  assert.equal(spawns[0].env.PI_REVIEW_API_URL, "http://127.0.0.1:43133");
  assert.equal(spawns[0].env.PI_REVIEW_PR_KEY, "github.com/org/repo#1");
  assert.equal(spawns[0].env.PI_REVIEW_HEAD_SHA, "abcdef1234567");
  assert.equal(spawns[0].env.PI_REVIEW_TARGET, JSON.stringify({ path: "src/a.ts", line: 9, side: "RIGHT" }));

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
