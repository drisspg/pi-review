import type { LogEntry } from "./logger.js";
import type { StoredPullRequest } from "./types.js";

export type ShellApiDeps = {
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  logEntries: () => LogEntry[];
};

export type ShellApi = {
  health: () => { ok: true };
  prs: () => Promise<{ prs: StoredPullRequest[] }>;
  logs: () => { logs: LogEntry[] };
};

export function createShellApi(deps: ShellApiDeps): ShellApi {
  return {
    health() {
      return { ok: true };
    },
    async prs() {
      return { prs: await deps.listRecentPullRequests() };
    },
    logs() {
      return { logs: deps.logEntries() };
    },
  };
}
