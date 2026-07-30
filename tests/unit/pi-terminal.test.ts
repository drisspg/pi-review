import assert from "node:assert/strict";
import test from "node:test";

import { createPiTerminalManager, parsePiTerminalClientMessage, parsePiTerminalRequest, type PiTerminalPeer, type PiTerminalServerMessage } from "../../src/pi-terminal.js";

class FakeProcess {
  pid = 42;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  dataListener: (data: string) => void = () => undefined;
  exitListener: (event: { exitCode: number; signal?: number }) => void = () => undefined;

  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
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
  assert.equal(parsePiTerminalRequest("/api/pi/terminal?session=main"), null);
  assert.equal(parsePiTerminalRequest("/api/pi/terminal?prKey=../../etc&session=main"), null);
  assert.equal(parsePiTerminalRequest("/api/other?prKey=github.com/org/repo%231"), null);
});

test("bounds terminal resize and input messages", () => {
  assert.deepEqual(parsePiTerminalClientMessage(JSON.stringify({ type: "resize", cols: 0, rows: 900 })), { type: "resize", cols: 2, rows: 500 });
  assert.deepEqual(parsePiTerminalClientMessage(JSON.stringify({ type: "input", data: "hello" })), { type: "input", data: "hello" });
  assert.equal(parsePiTerminalClientMessage("not-json"), null);
  assert.equal(parsePiTerminalClientMessage(JSON.stringify({ type: "input", data: "x".repeat(64_001) })), null);
});

test("attaches a peer to one persistent Pi PTY", async () => {
  const process = new FakeProcess();
  const spawns: Array<{ command: string; args: string[]; cwd: string }> = [];
  const manager = createPiTerminalManager({
    cwdForPr: () => "/tmp/pr-worktree",
    sessionRoot: "/tmp/pi-review-terminal-test",
    spawn: (command, args, options) => {
      spawns.push({ command, args, cwd: options.cwd });
      return process as never;
    },
  });
  const first = new FakePeer();
  await manager.attach(first, { prKey: "github.com/org/repo#1", session: "main", context: "Review line 7" });
  assert.deepEqual(first.messages, [{ type: "ready", pid: 42 }]);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, "pi");
  assert.equal(spawns[0].cwd, "/tmp/pr-worktree");
  assert.deepEqual(spawns[0].args, ["--session-dir", "/tmp/pi-review-terminal-test/github.com-org-repo-1/main", "--continue", "--name", "Pi Review · main", "--append-system-prompt", "Review line 7"]);

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

  await manager.disposePr("github.com/org/repo#1");
  assert.equal(process.killed, true);
  assert.deepEqual(first.closed, [1001, "Pull request closed"]);
});

test("reports a missing PR checkout without spawning", async () => {
  const peer = new FakePeer();
  const manager = createPiTerminalManager({ cwdForPr: () => null, sessionRoot: "/tmp/pi-review-terminal-test" });
  await manager.attach(peer, { prKey: "github.com/org/repo#1", session: "main" });
  assert.deepEqual(peer.messages, [{ type: "error", message: "Open this pull request before starting its terminal." }]);
  assert.deepEqual(peer.closed, [1011, "Terminal startup failed"]);
});
