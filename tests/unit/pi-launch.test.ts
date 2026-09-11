import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { piLaunch, piModelArgs, readPiLauncherCommand } from "../../src/pi-launch.js";

test("Pi launch preserves the authenticated wrapper and removes parent session identity", () => {
  const env = { PI_BIN: "/user/pi-work", SHELL: "/bin/zsh", PI_SESSION_ID: "parent", PI_SESSION_FILE: "/parent.jsonl", PI_BINARY_OVERRIDE: "/fork", PATH: ["/repo/node_modules/.bin", "/user/bin"].join(delimiter) };
  const args = ["--name", "spaces; $(not a command)"];
  const launch = piLaunch(args, env, null);
  assert.equal(launch.command, "/user/pi-work");
  assert.deepEqual(launch.args, args);
  assert.equal(launch.env.PI_BINARY_OVERRIDE, "/fork");
  assert.equal(launch.env.PATH, "/user/bin");
  assert.equal(launch.env.PI_SESSION_ID, undefined);
  assert.equal(launch.env.PI_SESSION_FILE, undefined);
  assert.equal(env.PI_SESSION_ID, "parent");
  assert.equal(piLaunch(args, env, "/local/pi").command, "/local/pi");
  assert.equal(piLaunch(args, {}, "~/bin/pi").command, join(homedir(), "bin/pi"));
  assert.equal(piLaunch(args, { ...env, PI_REVIEW_PI_COMMAND: "/explicit/pi" }, "/local/pi").command, "/explicit/pi");
});

test("Pi launch never evaluates shell syntax or starts interactive shell helpers", () => {
  const args = ["--append-system-prompt", "hello; $(touch unwanted)"];
  const launch = piLaunch(args, { SHELL: "/bin/zsh", PATH: "/missing-bin" }, null);
  assert.equal(launch.command, "pi");
  assert.deepEqual(launch.args, args);
});

test("Pi model selection follows global settings, ignores PR settings, and fails closed on malformed configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-model-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "pr");
  try {
    await mkdir(agentDir);
    const localConfig = join(root, ".pi-review.local.json");
    assert.equal(readPiLauncherCommand(localConfig), null);
    await writeFile(localConfig, JSON.stringify({ piCommand: "~/bin/pi-work" }));
    assert.equal(readPiLauncherCommand(localConfig), "~/bin/pi-work");
    await writeFile(localConfig, "{}");
    assert.throws(() => readPiLauncherCommand(localConfig), /Expected piCommand/);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "untrusted", defaultModel: "untrusted" }));
    assert.deepEqual(piModelArgs(cwd, agentDir), []);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-6-astra" }));
    assert.deepEqual(piModelArgs(cwd, agentDir), ["--provider", "openai", "--model", "gpt-6-astra"]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-fable-5-1" }));
    assert.deepEqual(piModelArgs(cwd, agentDir), ["--provider", "anthropic", "--model", "claude-fable-5-1"]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai" }));
    assert.throws(() => piModelArgs(cwd, agentDir), /both defaultProvider and defaultModel/);
    await writeFile(join(agentDir, "settings.json"), "invalid json");
    assert.throws(() => piModelArgs(cwd, agentDir), /Cannot read Pi settings/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
