#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function filesUnder(path) {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesUnder(join(path, entry.name)));
}

function newestMtime(paths) {
  let newest = 0;
  for (const path of paths.flatMap((candidate) => filesUnder(candidate))) {
    const stat = statSync(path);
    newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

function oldestMtime(paths) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    if (!existsSync(path)) return 0;
    const stat = statSync(path);
    oldest = Math.min(oldest, stat.mtimeMs);
  }
  return oldest;
}

const installMarker = join("node_modules", ".package-lock.json");
if (!existsSync("node_modules") || newestMtime(["package.json", "package-lock.json"]) > newestMtime([installMarker])) {
  console.log("\n[pi-review] Installing dependencies...\n");
  run(npm, ["install"]);
}

const buildOutputs = [join("dist-server", "server.js"), join("dist-web", "index.html")];
const newestBuildInput = newestMtime(["package.json", "tsconfig.json", "tsconfig.web.json", "vite.config.ts", "index.html", "src", "web"]);
const oldestBuildOutput = oldestMtime(buildOutputs);
if (oldestBuildOutput === 0 || newestBuildInput > oldestBuildOutput) {
  console.log("\n[pi-review] Building server and web app...\n");
  run(npm, ["run", "build"]);
}

console.log("\n[pi-review] Starting http://127.0.0.1:43133\n");
run(process.execPath, [join("dist-server", "server.js")]);
