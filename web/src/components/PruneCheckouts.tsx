import { Checkbox } from "@primer/react";
import { useEffect, useState } from "react";

import { api, errorMessage, logUsage } from "../api";
import { Button } from "./Button";
import { ModalShell } from "./Modal";

type PruneStatus = "merged" | "landed" | "closed" | "open" | "unknown";
type Candidate = { prKey: string; url: string; title: string; status: PruneStatus; blocked: string | null };
export type PruneResult = { deleted: string[]; kept: Array<{ prKey: string; reason: string }>; preserved: number };

const STATUS_LABEL: Record<PruneStatus, string> = { merged: "merged", landed: "landed (closed + Merged label)", closed: "closed without landing", open: "open", unknown: "state unknown" };

/**
 * Preview-then-confirm cleanup of local checkouts for landed PRs. Landed PRs are pre-selected;
 * closed-but-not-landed PRs can be opted in; PRs with a live Pi terminal cannot be selected.
 * The server re-checks GitHub state and runs the normal checkout safety checks on confirm.
 */
export function PruneCheckoutsModal({ close, onPruned }: { close: () => void; onPruned: (result: PruneResult) => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [result, setResult] = useState<PruneResult | null>(null);

  useEffect(() => {
    api<{ candidates: Candidate[] }>("/api/pr/checkout/prune/preview", { method: "POST", body: "{}" })
      .then(({ candidates: next }) => {
        setCandidates(next);
        setSelected(new Set(next.filter((candidate) => candidate.blocked == null && (candidate.status === "merged" || candidate.status === "landed")).map((candidate) => candidate.prKey)));
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  }, []);

  const prunable = (candidates ?? []).filter((candidate) => candidate.status === "merged" || candidate.status === "landed" || candidate.status === "closed");
  const openCount = (candidates ?? []).length - prunable.length;
  const toggle = (prKey: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(prKey)) next.delete(prKey);
    else next.add(prKey);
    return next;
  });

  async function prune(): Promise<void> {
    setPruning(true);
    setError(null);
    try {
      const includeClosed = prunable.some((candidate) => candidate.status === "closed" && selected.has(candidate.prKey));
      const next = await api<PruneResult>("/api/pr/checkout/prune", { method: "POST", body: JSON.stringify({ prKeys: [...selected], includeClosed }) });
      setResult(next);
      logUsage("checkout:prune", { deleted: next.deleted.length, kept: next.kept.length });
      onPruned(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPruning(false);
    }
  }

  return <ModalShell open onOpenChange={(open) => { if (!open && !pruning) close(); }} label="Prune landed checkouts" className="pi-modal prune-modal">
    <div className="pi-modal-head">
      <div><h2>Prune landed checkouts</h2><p className="muted">Deletes local checkouts for PRs that landed. Saved reviews, drafts, and session history are kept; reopening a PR recreates its checkout.</p></div>
    </div>
    <div className="pi-modal-body prune-body">
      {error != null && <p className="inbox-error" role="alert">{error}</p>}
      {result != null ? <div className="prune-result">
        <p><strong>Deleted {result.deleted.length}</strong> checkout{result.deleted.length === 1 ? "" : "s"}{result.preserved > 0 ? ` (re-fetched ${result.preserved} older reviewed revision${result.preserved === 1 ? "" : "s"} from GitHub first)` : ""}.</p>
        {result.kept.length > 0 && <><p>Kept {result.kept.length}:</p><ul>{result.kept.map((item) => <li key={item.prKey}><code>{item.prKey.replace("github.com/", "")}</code>: {item.reason}</li>)}</ul></>}
      </div> : candidates == null ? <p className="muted">Checking which PRs landed…</p> : prunable.length === 0 ? <p className="muted">Nothing to prune: none of your {candidates.length} local checkouts belong to landed or closed PRs.</p> : <>
        <ul className="prune-list">{prunable.map((candidate) => <li key={candidate.prKey} className={candidate.blocked != null ? "blocked" : undefined}>
          <label>
            <Checkbox checked={selected.has(candidate.prKey)} disabled={candidate.blocked != null || pruning} onChange={() => toggle(candidate.prKey)} />
            <span className="prune-title">{candidate.title}</span>
            <code>{candidate.prKey.replace("github.com/", "")}</code>
            <span className={`prune-status status-${candidate.status}`}>{STATUS_LABEL[candidate.status]}</span>
            {candidate.blocked != null && <span className="muted">— skipped: {candidate.blocked}</span>}
          </label>
        </li>)}</ul>
        <p className="muted">{openCount} checkout{openCount === 1 ? "" : "s"} for open PRs {openCount === 1 ? "is" : "are"} left alone. Closed-without-landing PRs are only pruned if you tick them.</p>
      </>}
    </div>
    <div className="pi-modal-foot">
      {result != null ? <Button className="pi-primary" onClick={close}>Done</Button> : <>
        <Button variant="muted" onClick={close} disabled={pruning}>Cancel</Button>
        <Button className="pi-primary" disabled={pruning || selected.size === 0} onClick={() => void prune()}>{pruning ? "Pruning…" : `Delete ${selected.size} checkout${selected.size === 1 ? "" : "s"}`}</Button>
      </>}
    </div>
  </ModalShell>;
}
