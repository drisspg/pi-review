/** Keep terminal and background agents on the user's Pi launcher and saved model. */
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localConfigPath = () => process.env.PI_REVIEW_LOCAL_CONFIG?.trim() || fileURLToPath(new URL("../.pi-review.local.json", import.meta.url));

/** Machine-local Pi Review overrides; `model` is `provider/id`. */
export type PiReviewLocalConfig = { piCommand?: string; model?: { provider: string; id: string }; thinkingLevel?: string };

/** Read this app checkout's optional machine-local config, never a reviewed PR's config. */
export function readPiReviewLocalConfig(configPath = localConfigPath()): PiReviewLocalConfig {
  let raw: string;
  try { raw = readFileSync(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const config = JSON.parse(raw);
  const text = (key: string): string | undefined => {
    const value = config?.[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string ${key} in ${configPath}`);
    return value.trim();
  };
  const result: PiReviewLocalConfig = {};
  const piCommand = text("piCommand");
  if (piCommand) result.piCommand = piCommand;
  const model = text("model");
  if (model) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) throw new Error(`Expected model as provider/id in ${configPath}`);
    result.model = { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  }
  const thinkingLevel = text("thinkingLevel");
  if (thinkingLevel) result.thinkingLevel = thinkingLevel;
  return result;
}

export function readPiLauncherCommand(configPath = localConfigPath()): string | null {
  return readPiReviewLocalConfig(configPath).piCommand ?? null;
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

/** Pin the Pi Review override, else the global default, even when continuing an older session on another provider. */
export function piModelArgs(cwd = process.cwd(), agentDir = getAgentDir(), local = readPiReviewLocalConfig()): string[] {
  if (local.model) return ["--provider", local.model.provider, "--model", local.model.id];
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const errors = settings.drainErrors().filter((error) => error.scope === "global");
  if (errors.length) throw new Error(`Cannot read Pi settings: ${errors[0].error.message}`);
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  if (!provider && !model) return [];
  if (!provider || !model) throw new Error("Set both defaultProvider and defaultModel in Pi settings before starting a review agent.");
  return ["--provider", provider, "--model", model];
}

/** Pi Review's machine-local thinking override applies to every agent and terminal. */
export function piThinkingLevel(fallback: string, local = readPiReviewLocalConfig()): string {
  return local.thinkingLevel ?? fallback;
}
