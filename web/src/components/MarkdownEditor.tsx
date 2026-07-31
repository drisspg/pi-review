import { Textarea } from "@primer/react";
import { type KeyboardEventHandler, useState } from "react";

import { autoGrowTextarea } from "../lib/dom";
import { MarkdownText } from "./Markdown";

/** Edit Markdown with GitHub-style Write and Preview tabs. */
export function MarkdownEditor({ value, onChange, ariaLabel, placeholder, autoFocus = false, rows = 1, onKeyDown }: { value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string; autoFocus?: boolean; rows?: number; onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement> }) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  return <div className="markdown-editor">
    <div className="markdown-editor-tabs" role="tablist" aria-label="Markdown editor modes">
      <button type="button" role="tab" aria-selected={mode === "write"} className={mode === "write" ? "active" : ""} onClick={() => setMode("write")}>Write</button>
      <button type="button" role="tab" aria-selected={mode === "preview"} className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button>
    </div>
    {mode === "write"
      ? <Textarea autoFocus={autoFocus} block resize="none" rows={rows} value={value} onChange={(event) => onChange(event.target.value)} onInput={(event) => autoGrowTextarea(event.currentTarget)} onKeyDown={onKeyDown} ref={(element) => autoGrowTextarea(element)} placeholder={placeholder} aria-label={ariaLabel} />
      : <div className="markdown-editor-preview">{value.trim().length === 0 ? <p className="muted">Nothing to preview.</p> : <MarkdownText text={value} />}</div>}
  </div>;
}
