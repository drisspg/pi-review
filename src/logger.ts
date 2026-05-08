export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
  timestamp: string;
};

const maxEntries = 500;
const entries: LogEntry[] = [];
let nextId = 1;

function write(level: LogLevel, scope: string, message: string, data?: unknown): LogEntry {
  const entry = { id: nextId, level, scope, message, data, timestamp: new Date().toISOString() };
  nextId += 1;
  entries.push(entry);
  entries.splice(0, Math.max(0, entries.length - maxEntries));
  const payload = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console[level === "debug" ? "log" : level](`[${entry.timestamp}] ${level.toUpperCase()} ${scope} ${message}${payload}`);
  return entry;
}

export const logger = {
  debug: (scope: string, message: string, data?: unknown) => write("debug", scope, message, data),
  info: (scope: string, message: string, data?: unknown) => write("info", scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => write("warn", scope, message, data),
  error: (scope: string, message: string, data?: unknown) => write("error", scope, message, data),
  entries: () => [...entries],
};
