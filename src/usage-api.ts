import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export type UsageEventSource = "server" | "web";

export type UsageEvent = {
  ts: string;
  source: UsageEventSource;
  name: string;
  data?: Record<string, unknown>;
};

export type UsageApi = {
  logPath: string;
  record: (source: UsageEventSource, name: string, data?: Record<string, unknown>) => void;
  recordClientEvents: (payload: Record<string, unknown>) => { recorded: number };
};

export type UsageApiDeps = {
  appendLine: (line: string) => Promise<void>;
  logPath: string;
  now: () => string;
  onError: (error: unknown) => void;
};

const maxClientEventsPerBatch = 50;
const maxEventNameLength = 120;

/** Usage log lives next to the state file so test/dev instances never pollute the real log. */
export function defaultUsageLogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_REVIEW_USAGE_LOG_PATH != null) return resolve(env.PI_REVIEW_USAGE_LOG_PATH);
  const statePath = env.PI_REVIEW_STATE_PATH == null
    ? resolve(homedir(), ".pi", "agent", "state", "pi-pr-review", "state.json")
    : resolve(env.PI_REVIEW_STATE_PATH);
  return resolve(dirname(statePath), `${basename(statePath).replace(/\.json$/, "")}.usage.jsonl`);
}

export function defaultUsageApiDeps(logger: { warn: (scope: string, message: string, data?: unknown) => void }, logPath = defaultUsageLogPath()): UsageApiDeps {
  let ensuredDir = false;
  return {
    async appendLine(line) {
      if (!ensuredDir) {
        await mkdir(dirname(logPath), { recursive: true });
        ensuredDir = true;
      }
      await appendFile(logPath, line, "utf8");
    },
    logPath,
    now: () => new Date().toISOString(),
    onError: (error) => logger.warn("usage", "usage log write failed", { error: error instanceof Error ? error.message : String(error) }),
  };
}

export function createUsageApi(deps: UsageApiDeps): UsageApi {
  let writeQueue = Promise.resolve();
  let reportedError = false;

  function record(source: UsageEventSource, name: string, data?: Record<string, unknown>): void {
    const event: UsageEvent = { ts: deps.now(), source, name, ...(data === undefined ? {} : { data }) };
    writeQueue = writeQueue
      .then(() => deps.appendLine(`${JSON.stringify(event)}\n`))
      .catch((error: unknown) => {
        if (reportedError) return;
        reportedError = true;
        deps.onError(error);
      });
  }

  function recordClientEvents(payload: Record<string, unknown>): { recorded: number } {
    if (!Array.isArray(payload.events)) throw new Error("Expected events array");
    let recorded = 0;
    for (const item of payload.events.slice(0, maxClientEventsPerBatch)) {
      if (typeof item !== "object" || item == null) continue;
      const { name, data } = item as { name?: unknown; data?: unknown };
      if (typeof name !== "string" || name.length === 0 || name.length > maxEventNameLength) continue;
      record("web", name, typeof data === "object" && data != null && !Array.isArray(data) ? data as Record<string, unknown> : undefined);
      recorded += 1;
    }
    return { recorded };
  }

  return { logPath: deps.logPath, record, recordClientEvents };
}
