import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { ownCheckoutCache } from "../../src/checkout-cache.js";

async function waitFor(check: () => boolean | Promise<boolean>, message: string, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(message);
}

function running(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null;
}

async function unusedPort(): Promise<number> {
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done) => reservation.close(() => done()));
  return address.port;
}

test("repeated interrupts close unresponsive terminal sockets and release cache ownership", { timeout: 45_000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-review-shutdown-"));
  const port = await unusedPort();
  const cache = resolve(root, "cache");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, PI_PR_REVIEW_PORT: String(port), PI_REVIEW_STATE_PATH: resolve(root, "state.json"), PI_REVIEW_CACHE_DIR: cache, PI_REVIEW_DISABLE_AUTO_REVIEWS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  let socket: Socket | undefined;
  t.after(async () => {
    socket?.destroy();
    if (running(child)) { child.kill("SIGTERM"); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(async () => {
    if (!running(child)) throw new Error(output);
    return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false);
  }, "server did not start");
  socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  await once(socket, "connect");
  let received = "";
  socket.on("data", (data) => { received += data.toString(); });
  // An unregistered terminal starts no Pi process. This raw peer deliberately never
  // acknowledges the server's WebSocket close frame, like a disappeared browser.
  socket.write("GET /api/pi/terminal?prKey=missing&session=main HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  await waitFor(() => received.includes("101 Switching Protocols"), "terminal socket did not upgrade", 5_000);
  child.kill("SIGINT");
  await waitFor(() => output.includes("server shutdown"), "shutdown was not requested", 5_000);
  if (running(child)) child.kill("SIGINT");
  await waitFor(() => !running(child), "shutdown waited for the dead browser", 5_000);
  await exited;
  assert.equal(child.exitCode, 0, output);
  assert.equal(child.signalCode, null);
  assert.equal(existsSync(resolve(cache, ".checkout-owner")), false);
  const release = ownCheckoutCache(cache);
  release();
});

test("interrupts during asynchronous ownership checking release the lock without starting the server", { timeout: 45_000, skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-review-startup-stop-"));
  const home = resolve(root, "home");
  const bin = resolve(root, "bin");
  const marker = resolve(root, "probe.started");
  const cache = resolve(home, ".pi/agent/state/pi-pr-review");
  await mkdir(bin);
  await writeFile(resolve(bin, "lsof"), '#!/bin/sh\nprintf ready > "$STARTUP_MARKER"\nsleep 1\n');
  await writeFile(resolve(bin, "ps"), "#!/bin/sh\nexit 0\n");
  await Promise.all(["lsof", "ps"].map((file) => chmod(resolve(bin, file), 0o755)));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, STARTUP_MARKER: marker, PI_PR_REVIEW_PORT: String(await unusedPort()), PI_REVIEW_STATE_PATH: resolve(root, "state.json"), PI_REVIEW_CACHE_DIR: cache, PI_REVIEW_DISABLE_AUTO_REVIEWS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (running(child)) { child.kill("SIGTERM"); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => { if (!running(child)) throw new Error(output); return existsSync(marker); }, "ownership probe did not start");
  assert.ok(existsSync(resolve(cache, ".checkout-owner")));
  child.kill("SIGINT");
  await new Promise((done) => setTimeout(done, 50));
  child.kill("SIGINT");
  await exited;
  assert.equal(child.exitCode, 0, output);
  assert.equal(child.signalCode, null);
  assert.equal(existsSync(resolve(cache, ".checkout-owner")), false);
  assert.equal(output.includes("server listening"), false);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  test(`npm start launcher forwards ${signal} and waits through repeated signals`, { timeout: 20_000, skip: process.platform === "win32" }, async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "pi-review-launcher-"));
    await mkdir(resolve(root, "scripts"));
    await copyFile("scripts/start.mjs", resolve(root, "scripts/start.mjs"));
    // These markers bypass installation/build: this test exercises only the real launcher.
    await writeFile(resolve(root, "package.json"), '{"type":"module"}');
    await mkdir(resolve(root, "node_modules"));
    await writeFile(resolve(root, "node_modules/.package-lock.json"), "{}");
    await mkdir(resolve(root, "dist-web"));
    await writeFile(resolve(root, "dist-web/index.html"), "fixture");
    await mkdir(resolve(root, "dist-server"));
    await writeFile(resolve(root, "dist-server/server.js"), `
      import { writeFileSync } from "node:fs";
      process.on("exit", () => writeFileSync("child.exited", "yes"));
      const keepAlive = setInterval(() => {}, 1000);
      let stopping = false;
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        writeFileSync("child.stopping", signal);
        setTimeout(() => { clearInterval(keepAlive); writeFileSync("child.stopped", "yes"); process.exit(0); }, 400);
      });
      writeFileSync("child.pid", String(process.pid));
    `);
    const child = spawn(process.execPath, ["scripts/start.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const exited = once(child, "exit");
    t.after(async () => {
      if (running(child)) { child.kill("SIGTERM"); await exited; }
      // Also clean up the fixture's own child if an old/broken launcher orphaned it.
      if (existsSync(resolve(root, "child.pid")) && !existsSync(resolve(root, "child.exited"))) {
        const pid = Number(await readFile(resolve(root, "child.pid"), "utf8"));
        try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await waitFor(() => existsSync(resolve(root, "child.exited")), "fixture child did not exit", 5_000);
      }
      await rm(root, { recursive: true, force: true });
    });
    await waitFor(() => {
      if (!running(child)) throw new Error(output);
      return existsSync(resolve(root, "child.pid"));
    }, "launcher did not start its child", 10_000);
    child.kill(signal); // Only the launcher receives this signal, not its process group.
    await waitFor(() => existsSync(resolve(root, "child.stopping")), "launcher did not forward signal", 5_000);
    assert.equal(await readFile(resolve(root, "child.stopping"), "utf8"), signal);
    child.kill(signal);
    assert.ok(running(child), "launcher exited before its child finished cleanup");
    await exited;
    assert.equal(child.exitCode, 0, output);
    assert.equal(child.signalCode, null);
    assert.ok(existsSync(resolve(root, "child.stopped")));
  });
}
