import type { PullRequestRef } from "./types.js";

/**
 * Prune local PR checkouts whose PRs have landed. "Landed" means merged on GitHub, or closed
 * with the `Merged` label that pytorchmergebot applies when it lands a PR by commit (those
 * PRs show as CLOSED). Closed-but-not-landed PRs are reported separately and only pruned when
 * explicitly selected. Before deleting, reviewed revisions that a force-push left without a
 * ref are re-fetched from GitHub (when GitHub still has them) so the checkout safety check can
 * verify them; deletion itself goes through the normal checkout delete with all its checks.
 */
export type PrunePrState = { state: "OPEN" | "CLOSED" | "MERGED"; landedLabel: boolean };
export type PruneStatus = "merged" | "landed" | "closed" | "open" | "unknown";
export type PruneCandidate = { prKey: string; url: string; title: string; status: PruneStatus; /** Why it is not prunable right now, if so. */ blocked: string | null };
export type PruneResult = { deleted: string[]; kept: Array<{ prKey: string; reason: string }>; preserved: number };

export type CheckoutPruneDeps = {
  listLocalCheckouts: () => Promise<Array<{ prKey: string; url: string; title: string; ref: PullRequestRef }>>;
  fetchPrStates: (refs: PullRequestRef[]) => Promise<Map<string, PrunePrState>>;
  /** Live Pi terminal on the PR: deleting would kill the user's session, so prune skips it. */
  hasLiveTerminal: (prKey: string) => boolean;
  preservePublishedRevisions: (ref: PullRequestRef) => Promise<{ preserved: number; unpublished: string[] }>;
  deleteCheckout: (url: string) => Promise<unknown>;
  logger?: { info: (scope: string, message: string, data?: Record<string, unknown>) => void };
};

export type CheckoutPruneApi = {
  preview: () => Promise<{ candidates: PruneCandidate[] }>;
  prune: (payload: Record<string, unknown>) => Promise<PruneResult>;
};

export function pruneStatus(state: PrunePrState | undefined): PruneStatus {
  if (state == null) return "unknown";
  if (state.state === "MERGED") return "merged";
  if (state.state === "CLOSED") return state.landedLabel ? "landed" : "closed";
  return "open";
}

export function isLanded(status: PruneStatus): boolean {
  return status === "merged" || status === "landed";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCheckoutPruneApi(deps: CheckoutPruneDeps): CheckoutPruneApi {
  let running: Promise<PruneResult> | null = null;

  async function candidates(): Promise<Array<PruneCandidate & { ref: PullRequestRef }>> {
    const local = await deps.listLocalCheckouts();
    const states = await deps.fetchPrStates(local.map((checkout) => checkout.ref));
    return local.map((checkout) => {
      const status = pruneStatus(states.get(checkout.prKey));
      return { ...checkout, status, blocked: deps.hasLiveTerminal(checkout.prKey) ? "a Pi terminal is open on this PR" : null };
    });
  }

  async function run(payload: Record<string, unknown>): Promise<PruneResult> {
    const selected = Array.isArray(payload.prKeys) ? new Set(payload.prKeys.filter((key): key is string => typeof key === "string")) : null;
    const includeClosed = payload.includeClosed === true;
    const result: PruneResult = { deleted: [], kept: [], preserved: 0 };
    // Re-read GitHub state now; a preview may be stale, and only landed (or explicitly allowed closed) PRs qualify.
    for (const candidate of await candidates()) {
      if (selected != null && !selected.has(candidate.prKey)) continue;
      if (!isLanded(candidate.status) && !(includeClosed && candidate.status === "closed")) {
        if (selected != null) result.kept.push({ prKey: candidate.prKey, reason: `PR is ${candidate.status}, not landed` });
        continue;
      }
      if (candidate.blocked != null) {
        result.kept.push({ prKey: candidate.prKey, reason: candidate.blocked });
        continue;
      }
      try {
        const preserved = await deps.preservePublishedRevisions(candidate.ref);
        result.preserved += preserved.preserved;
        await deps.deleteCheckout(candidate.url);
        result.deleted.push(candidate.prKey);
      } catch (error) {
        result.kept.push({ prKey: candidate.prKey, reason: errorText(error) });
      }
    }
    deps.logger?.info("checkout", "prune complete", { deleted: result.deleted.length, kept: result.kept.length, preserved: result.preserved });
    return result;
  }

  return {
    async preview() {
      return { candidates: (await candidates()).map(({ ref: _ref, ...candidate }) => candidate) };
    },
    prune(payload) {
      if (running != null) throw new Error("A prune is already running");
      running = run(payload).finally(() => { running = null; });
      return running;
    },
  };
}
