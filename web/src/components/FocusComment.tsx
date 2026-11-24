import { createContext, useContext, useMemo, useState } from "react";
import { focusCommentAnchor, targetLabel } from "../lib/comments";
import { newId } from "../lib/pr";
import type { DraftComment, FocusArea, PullFile } from "../types";
import { Button } from "./Button";
import { MarkdownEditor } from "./MarkdownEditor";
import { ModalShell } from "./Modal";

export const FocusCommentContext = createContext<{ currentScanId?: string; files: PullFile[]; addDraft: (comment: DraftComment) => void } | null>(null);

export function FocusCommentButton({ area }: { area: FocusArea }) {
  const context = useContext(FocusCommentContext);
  const patch = context?.files.find(file => file.filename === area.path)?.patch;
  const anchor = useMemo(() => focusCommentAnchor(area, patch), [area, patch]);
  const unavailable = !context?.currentScanId ? "Open a finding for the current PR revision to comment." : "This finding has no reviewable lines in the PR diff.";
  if (!context?.currentScanId || !anchor) return <Button variant="muted" className="small-muted-button" disabled title={unavailable}>Add comment</Button>;
  return <CommentAction key={context.currentScanId} area={area} anchor={anchor} addDraft={context.addDraft} />;
}

function CommentAction({ area, anchor, addDraft }: { area: FocusArea; anchor: Omit<DraftComment, "id" | "body">; addDraft: (comment: DraftComment) => void }) {
  const [text, setText] = useState<string | null>(null);
  function save() {
    const body = text?.trim();
    if (!body) return;
    addDraft({ ...anchor, id: newId(), body });
    setText(null);
  }
  return <>
    <Button variant="muted" className="small-muted-button" aria-label={`Add comment: ${area.title}`} onClick={() => setText("")}>Add comment</Button>
    {text != null && <ModalShell open className="pi-modal focus-comment-modal" label="Comment on finding" onOpenChange={open => { if (!open) setText(null); }}>
      <header className="pi-modal-head"><div><h2>Comment on finding</h2><p>{area.title}</p></div></header>
      <div className="pi-modal-body">
        <p>Local draft on <code>{targetLabel(anchor)}</code></p>
        <MarkdownEditor autoFocus rows={3} ariaLabel="Review comment" value={text} onChange={setText} onKeyDown={event => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
        }} />
      </div>
      <footer className="pi-modal-foot"><div className="pi-modal-foot-actions"><Button variant="muted" onClick={() => setText(null)}>Cancel</Button><Button className="composer-submit" disabled={!text.trim()} onClick={save}>Add draft comment</Button></div></footer>
    </ModalShell>}
  </>;
}
