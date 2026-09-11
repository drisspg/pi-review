/** Live launcher/model/tool/terminal check; uses no GitHub API or persisted review drafts. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PiAgentProcess } from "../src/pi-agent-process.js";
import { piFinalAssistantAnswer } from "../src/pi-session.js";
import { createPiTerminalManager, type PiTerminalPeer, type PiTerminalServerMessage } from "../src/pi-terminal.js";
import { createReviewDraftTool } from "../src/review-draft-tool.js";
import type { DraftReview, PullFile } from "../src/types.js";

/** Bound live checks without leaving a timeout behind on success. */
async function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Pi smoke check timed out")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Simulate only the browser peer; the manager and PTY are real. */
function peer(): PiTerminalPeer & { messages: PiTerminalServerMessage[]; input: (message: string) => void; disconnect: () => void } {
  return {
    messages: [], input: () => {}, disconnect: () => {},
    send(message) { this.messages.push(message); },
    close() {},
    onMessage(listener) { this.input = listener; },
    onClose(listener) { this.disconnect = listener; },
  };
}

const root = await mkdtemp(join(tmpdir(), "pi-review-agent-smoke-"));
const prKey = "github.com/pi-review/smoke#1";
const headSha = "abcdef1234567";
const comments: DraftReview["comments"] = [];
const tool = createReviewDraftTool(prKey, { headSha, files: [{ filename: "fixture.ts", patch: "@@ -1 +1 @@\n-old\n+new" } as PullFile] }, {
  async appendDraftReviewComment(key, sha, comment) {
    const saved = { ...comment, id: "smoke" };
    comments.push(saved);
    return { created: true, comment: saved, draftReview: { prKey: key, headSha: sha, event: "COMMENT", body: "", comments, updatedAt: new Date().toISOString() } };
  },
});
const manager = createPiTerminalManager({ cwdForPr: () => process.cwd(), sessionRoot: join(root, "terminals"), extensionPath: resolve("src/pi-review-terminal-extension.ts") });
let session: PiAgentProcess | undefined;
let terminalPid: number | undefined;
try {
  session = await PiAgentProcess.create({ cwd: process.cwd(), sessionDir: join(root, "background"), thinkingLevel: "low", tools: ["draft_review_comment"], customTools: [tool] });
  console.log(`Background: ${session.model?.provider}/${session.model?.id}`);
  await deadline(session.prompt("This is an integration test with an in-memory draft store. Call draft_review_comment once with path fixture.ts, line 1, side RIGHT, body PI_REVIEW_DRAFT_OK. Then reply with exactly PI_REVIEW_TOOL_OK. Do not read or modify repository files."), 45_000);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, "PI_REVIEW_DRAFT_OK");
  assert.equal(piFinalAssistantAnswer(session.messages), "PI_REVIEW_TOOL_OK");
  console.log("Background reply + server-owned draft tool: passed (in-memory only)");

  const first = peer();
  const request = { prKey, session: "compat", context: "Compatibility smoke test. Do not use tools or read or modify repository files." };
  await manager.attach(first, request);
  const ready = first.messages[0];
  assert.equal(ready?.type, "ready", JSON.stringify(first.messages));
  if (ready.type === "ready") terminalPid = ready.pid;
  // A PTY PID is not editor readiness: wait for Pi's model footer, not a fixed sleep.
  const output = () => first.messages.flatMap((message) => message.type === "output" ? [message.data] : []).join("");
  for (let attempt = 0; attempt < 120 && !output().includes(session.model!.id); attempt++) await delay(250);
  assert.ok(output().includes(session.model!.id), `Pi editor did not start: ${output().slice(-4_000)}`);
  first.input(JSON.stringify({ type: "input", data: "\u001b[200~Reply with exactly PI_REVIEW_TERMINAL_OK. Do not call tools.\u001b[201~\r" }));
  let terminalModel: string | undefined;
  for (let attempt = 0; attempt < 120 && !terminalModel; attempt++) {
    await delay(250);
    for (const item of await readdir(join(root, "terminals"), { recursive: true })) {
      if (!item.endsWith(".jsonl")) continue;
      for (const line of (await readFile(join(root, "terminals", item), "utf8")).trim().split("\n")) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const message = entry.message;
        if (message?.role === "assistant" && message.content?.some((part: { text?: string }) => part.text?.trim() === "PI_REVIEW_TERMINAL_OK")) {
          terminalModel = `${message.provider}/${message.model}`;
        }
      }
    }
  }
  assert.equal(terminalModel, `${session.model?.provider}/${session.model?.id}`, `Terminal must reply using the same configured model as background reviews. Output: ${output().slice(-4_000)}`);
  first.disconnect();
  const second = peer();
  await manager.attach(second, request);
  assert.deepEqual(second.messages[0], ready);
  assert.ok(second.messages.some((message) => message.type === "output"));
  console.log(`Terminal reply + reconnect to the same PTY: passed (${terminalModel})`);
} finally {
  await Promise.all([session?.dispose(), manager.dispose()]);
  if (terminalPid != null && process.platform !== "win32") {
    await delay(50);
    assert.throws(() => process.kill(-terminalPid!, 0), { code: "ESRCH" }, "Terminal process group must not leave shell helpers behind");
  }
  await rm(root, { recursive: true, force: true });
  console.log("Agent processes and temporary sessions cleaned up");
}
