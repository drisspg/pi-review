/** Keep terminal and background agents on the user's Pi launcher and saved model. */
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Read this app checkout's optional machine-local launcher, never a reviewed PR's config. */
export function readPiLauncherCommand(configPath = fileURLToPath(new URL("../.pi-review.local.json", import.meta.url))): string | null {
  let raw: string;
  try { raw = readFileSync(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const config = JSON.parse(raw);
  if (typeof config?.piCommand !== "string" || !config.piCommand.trim()) throw new Error(`Expected piCommand in ${configPath}`);
  return config.piCommand.trim();
}

/** Resolve an installed Pi without selecting npm's project-local SDK binary. */
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
        // Continue to the next executable user installation.
      }
    }
  }
  return "pi";
}

/** Honor the authenticated launcher without sourcing interactive shell startup scripts. */
export function piLaunch(args: string[], env: NodeJS.ProcessEnv = process.env, localCommand = readPiLauncherCommand()): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: env.PATH?.split(delimiter).filter((directory) => !/(^|[\\/])node_modules[\\/]\.bin$/.test(directory)).join(delimiter) };
  delete childEnv.PI_SESSION_FILE;
  delete childEnv.PI_SESSION_ID;
  const command = env.PI_REVIEW_PI_COMMAND?.trim() || localCommand || env.PI_BIN?.trim() || resolvePiTerminalCommand(childEnv.PATH);
  return { command: command.startsWith("~/") ? resolve(homedir(), command.slice(2)) : command, args, env: childEnv };
}

/** Pin the global default even when continuing an older session on another provider. */
export function piModelArgs(cwd = process.cwd(), agentDir = getAgentDir()): string[] {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const errors = settings.drainErrors().filter((error) => error.scope === "global");
  if (errors.length) throw new Error(`Cannot read Pi settings: ${errors[0].error.message}`);
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  if (!provider && !model) return [];
  if (!provider || !model) throw new Error("Set both defaultProvider and defaultModel in Pi settings before starting a review agent.");
  return ["--provider", provider, "--model", model];
}
