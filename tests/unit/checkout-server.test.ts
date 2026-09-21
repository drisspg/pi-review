import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createCheckoutCache } from "../../src/checkout-cache.js";

async function unusedPort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done) => socket.close(() => done()));
  return address.port;
}

test("real servers isolate checkout roots and exclude cross-process maintenance/sharing", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-review-server-cache-"));
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode != null || child.signalCode != null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function start(name: string, cacheName = name) {
    const port = await unusedPort();
    const state = resolve(directory, `${name}.json`);
    await writeFile(state, JSON.stringify({ prs: [{ key: "github.com/example/repo#1", ref: { host: "github.com", owner: "example", repo: "repo", number: 1 }, url: "https://github.com/example/repo/pull/1", lastOpenedAt: "2026-09-21T00:00:00Z" }], draftReviews: [{ prKey: "keep", body: "draft history" }] }));
    const cache = resolve(directory, `${cacheName}-cache`);
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      env: { ...process.env, PI_PR_REVIEW_PORT: String(port), PI_REVIEW_STATE_PATH: state, PI_REVIEW_CACHE_DIR: cache, PI_REVIEW_DISABLE_AUTO_REVIEWS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    // Match Playwright's startup budget; the full unit suite competes for cold tsx imports.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) return { child, cache, state, output, port };
      if (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok).catch(() => false)) return { child, cache, state, output, port };
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`Server did not start: ${output}`);
  }
  const first = await start("first");
  assert.equal(first.child.exitCode, null, first.output);
  const config = await fetch(`http://127.0.0.1:${first.port}/api/config`).then((response) => response.json());
  assert.equal(config.autoReviews, false);
  const stateBefore = await readFile(first.state);
  const history = () => fetch(`http://127.0.0.1:${first.port}/api/prs`).then((response) => response.json());
  assert.equal((await history()).prs[0].checkoutPresent, false);
  const checkout = resolve(first.cache, "worktrees/github.com/example/repo/pr-1");
  await mkdir(checkout, { recursive: true });
  assert.equal((await history()).prs[0].checkoutPresent, true);
  await rm(checkout, { recursive: true });
  assert.equal((await history()).prs[0].checkoutPresent, false);
  assert.deepEqual(await readFile(first.state), stateBefore);
  await assert.rejects(createCheckoutCache(first.cache).evict("worktrees/github.com/example/repo/pr-1", true), /owned/);
  const shared = await start("shared", "first");
  assert.equal(shared.child.exitCode, 1, shared.output);
  assert.match(shared.output, /owned or needs manual lock recovery/);
  const second = await start("second");
  assert.equal(second.child.exitCode, null, second.output);
  assert.ok(existsSync(resolve(first.cache, ".checkout-owner")));
  assert.ok(existsSync(resolve(second.cache, ".checkout-owner")));
  assert.deepEqual(await readFile(first.state), stateBefore);
  const exited = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await exited;
  assert.equal(existsSync(resolve(first.cache, ".checkout-owner")), false);
  assert.ok(existsSync(resolve(second.cache, ".checkout-owner")));
});
