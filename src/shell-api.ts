import type { LogEntry } from "./logger.js";
import type { PullRequestListItem, PullRequestRef, StoredPullRequest } from "./types.js";

export type ShellApiDeps = {
  hasCheckout: (ref: PullRequestRef) => boolean;
  listRecentPullRequests: () => Promise<StoredPullRequest[]>;
  logEntries: () => LogEntry[];
};

export type ShellApi = {
  health: () => { ok: true };
  prs: () => Promise<{ prs: PullRequestListItem[] }>;
  logs: () => { logs: LogEntry[] };
};

export function createShellApi(deps: ShellApiDeps): ShellApi {
  return {
    health() {
      return { ok: true };
    },
    async prs() {
      const prs = await deps.listRecentPullRequests();
      return { prs: prs.map((pr) => ({ ...pr, checkoutPresent: deps.hasCheckout(pr.ref) })) };
    },
    logs() {
      return { logs: deps.logEntries() };
    },
  };
}
