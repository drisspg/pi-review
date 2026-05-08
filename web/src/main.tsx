import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./styles.css";

type StoredPullRequest = { key: string; url: string; title: string; state: string; author: string | null; baseSha: string; headSha: string; filesChanged: number | null; existingCommentCount: number | null; lastOpenedAt: string };
type PullFile = { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; changes: number; patch?: string };
type PullReviewComment = { id: number; path: string; line?: number | null; start_line?: number | null; original_line?: number | null; side?: "RIGHT" | "LEFT" | null; original_side?: "RIGHT" | "LEFT" | null; body: string; html_url: string; user?: { login?: string } | null; updated_at?: string };
type PullIssueComment = { id: number; body: string; html_url: string; user?: { login?: string } | null; updated_at?: string };
type FileReviewState = { prKey: string; path: string; fingerprint: string; viewed: boolean; updatedAt: string };
type LogEntry = { id: number; level: "debug" | "info" | "warn" | "error"; scope: string; message: string; data?: unknown; timestamp: string };
type DiffRow = { kind: string; oldLine: number | null; newLine: number | null; text: string; hunk: string };
type Target = { path: string; line: number | null; startLine?: number | null; side: "RIGHT" | "LEFT"; hunk: string };
type ThreadMessage = { role: "user" | "pi"; text: string };
type Thread = { key: string; target: Target; collapsed: boolean; draft: string; asking?: boolean; messages: ThreadMessage[] };
type DraftComment = { id: string; path: string; line: number | null; startLine?: number | null; side: "RIGHT" | "LEFT"; body: string };
type DragSelection = { start: Target; current: Target; dragging: boolean };
type AiReview = { expanded: boolean; open: boolean; running: boolean; text: string };
type ThemeName = "github-dark" | "github-light" | "github-dimmed";
type OpenResponse = { pr: StoredPullRequest; files: PullFile[]; comments: PullReviewComment[]; issueComments: PullIssueComment[]; fileReviews: FileReviewState[] };

type DiffProps = {
  review: OpenResponse;
  openFiles: Record<string, boolean>;
  setOpenFiles: (open: Record<string, boolean>) => void;
  expandedContext: Record<string, boolean>;
  setExpandedContext: (expanded: Record<string, boolean>) => void;
  expandedNeighborRows: Record<string, DiffRow[]>;
  expandNeighbor: (file: PullFile, key: string, startLine: number, endLine: number) => Promise<void>;
  threads: Record<string, Thread>;
  setThreads: (threads: Record<string, Thread> | ((threads: Record<string, Thread>) => Record<string, Thread>)) => void;
  toggleThread: (target: Target, extend?: boolean) => void;
  setViewed: (file: PullFile, viewed: boolean) => Promise<void>;
  drafts: DraftComment[];
  setDrafts: (drafts: DraftComment[]) => void;
  editingDraftId: string | null;
  setEditingDraftId: (id: string | null) => void;
  askThread: (thread: Thread) => Promise<void>;
  sideWidth: number;
  setSideWidth: (width: number) => void;
  dragSelection: DragSelection | null;
  beginDrag: (target: Target) => void;
  updateDrag: (target: Target) => void;
  finishDrag: (target: Target) => void;
  handleRowClick: (target: Target, extend: boolean) => void;
};

function prUrlFromKey(key: string): string {
  const match = key.match(/^(https?:\/\/[^/]+|[^/]+)\/([^/]+)\/([^#]+)#(\d+)$/);
  if (match == null) return key;
  const host = match[1].startsWith("http") ? new URL(match[1]).host : match[1];
  return `https://${host}/${match[2]}/${match[3]}/pull/${match[4]}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

function parsePatchRows(patch: string | undefined): DiffRow[] {
  if (patch == null) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let currentHunk = "";
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk != null) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      currentHunk = line;
      rows.push({ kind: "hunk", oldLine: null, newLine: null, text: line, hunk: currentHunk });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", oldLine: null, newLine, text: line, hunk: currentHunk });
      newLine += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", oldLine, newLine: null, text: line, hunk: currentHunk });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: line, hunk: currentHunk });
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push({ kind: "meta", oldLine: null, newLine: null, text: line, hunk: currentHunk });
    }
  }
  return rows;
}

function targetKey(target: Target): string { return `${target.path}:${target.side}:${target.startLine ?? target.line ?? "file"}:${target.line ?? "file"}`; }
function commentTarget(comment: PullReviewComment): Target { return { path: comment.path, startLine: comment.start_line ?? comment.line ?? comment.original_line ?? null, line: comment.line ?? comment.original_line ?? null, side: comment.side ?? comment.original_side ?? "RIGHT", hunk: "" }; }
function draftMatchesTarget(draft: DraftComment, target: Target): boolean {
  return draft.path === target.path && draft.side === target.side && draft.line === target.line;
}

function threadForTarget(threads: Record<string, Thread>, target: Target): Thread | null {
  return threads[targetKey(target)] ?? Object.values(threads).find((thread) => thread.target.path === target.path && thread.target.side === target.side && thread.target.line === target.line) ?? null;
}

function isTargetInSelection(target: Target | null, selection: DragSelection | null): boolean {
  if (target == null || selection == null || target.line == null || selection.start.line == null || selection.current.line == null) return false;
  if (target.path !== selection.start.path || target.side !== selection.start.side) return false;
  const start = Math.min(selection.start.line, selection.current.line);
  const end = Math.max(selection.start.line, selection.current.line);
  return target.line >= start && target.line <= end;
}

function targetFromRow(row: HTMLElement | null): Target | null {
  if (row == null) return null;
  const line = Number.parseInt(row.dataset.line ?? "", 10);
  const path = row.dataset.path;
  const side = row.dataset.side;
  if (path == null || !Number.isInteger(line) || (side !== "RIGHT" && side !== "LEFT")) return null;
  return { path, line, side, hunk: row.dataset.hunk ?? "" };
}

function targetFromPoint(clientX: number, clientY: number): Target | null {
  return targetFromRow(document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".diff-row[data-path]") ?? null);
}
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("typescript", typescript);

function shortSha(sha: string): string { return sha.slice(0, 12); }
function targetLabel(target: Pick<Target, "path" | "line" | "startLine">): string { return `${target.path}:${target.line == null ? "file" : target.startLine != null && target.startLine !== target.line ? `${target.startLine}-${target.line}` : target.line}`; }
function newId(): string { return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`; }

function languageForPath(path: string | null | undefined): string {
  if (path == null) return "";
  if (/\.(cc|cpp|cu|cuh|c|h|hpp)$/.test(path)) return "cpp";
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.jsx?$/.test(path)) return "javascript";
  if (/\.py$/.test(path)) return "python";
  if (/\.json$/.test(path)) return "json";
  if (/\.(sh|bash|zsh)$/.test(path)) return "bash";
  return "";
}

function highlightedHtml(code: string, language: string): string {
  if (language.length > 0 && hljs.getLanguage(language) != null) return hljs.highlight(code, { language }).value;
  return hljs.highlightAuto(code).value;
}

function CodeText({ code, language }: { code: string; language: string }) {
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

function App() {
  const [input, setInput] = useState("");
  const [prs, setPrs] = useState<StoredPullRequest[]>([]);
  const [review, setReview] = useState<OpenResponse | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [expandedContext, setExpandedContext] = useState<Record<string, boolean>>({});
  const [expandedNeighborRows, setExpandedNeighborRows] = useState<Record<string, DiffRow[]>>({});
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [activeTarget, setActiveTarget] = useState<Target | null>(null);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const dragSelectionRef = useRef<DragSelection | null>(null);
  const draggedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [aiReview, setAiReview] = useState<AiReview>({ expanded: false, open: false, running: false, text: "" });
  const [busy, setBusy] = useState(false);
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sideWidth, setSideWidth] = useState(380);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => localStorage.getItem("pi-review-theme") as ThemeName || "github-dark");

  async function refreshHistory() { setPrs((await api<{ prs: StoredPullRequest[] }>("/api/prs")).prs); }
  async function refreshLogs() { setLogs((await api<{ logs: LogEntry[] }>("/api/logs")).logs.slice(-40).reverse()); }

  useEffect(() => { refreshHistory().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); refreshLogs().catch(() => undefined); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pi-review-theme", theme);
  }, [theme]);

  useEffect(() => {
    function beginWindowDrag(event: MouseEvent) {
      const target = event.target instanceof Element ? targetFromRow(event.target.closest<HTMLElement>(".diff-row[data-path]")) : null;
      if (target != null && event.button === 0) {
        beginDrag(target);
        event.preventDefault();
        return;
      }
      if (event.target instanceof Element && event.target.closest(".inline-thread") == null) pruneEmptyThreads();
    }

    function updateWindowDrag(event: MouseEvent) {
      if (dragSelectionRef.current == null) return;
      const target = targetFromPoint(event.clientX, event.clientY);
      if (target != null) updateDrag(target);
    }

    function finishWindowDrag(event: MouseEvent) {
      const selection = dragSelectionRef.current;
      if (selection == null) return;
      finishDrag(targetFromPoint(event.clientX, event.clientY) ?? selection.current);
    }

    window.addEventListener("mousedown", beginWindowDrag);
    window.addEventListener("mousemove", updateWindowDrag);
    window.addEventListener("mouseup", finishWindowDrag);
    return () => {
      window.removeEventListener("mousedown", beginWindowDrag);
      window.removeEventListener("mousemove", updateWindowDrag);
      window.removeEventListener("mouseup", finishWindowDrag);
    };
  });

  async function openPr(nextInput: string) {
    setBusy(true);
    setError(null);
    try {
      const data = await api<OpenResponse>("/api/pr/open", { method: "POST", body: JSON.stringify({ input: nextInput }) });
      setReview(data);
      setInput(data.pr.url);
      setOpenFiles(Object.fromEntries(data.files.map((file) => [file.filename, !data.fileReviews.find((state) => state.path === file.filename)?.viewed])));
      setThreads({});
      setActiveTarget(null);
      dragSelectionRef.current = null;
      setDragSelection(null);
      setDrafts([]);
      setExpandedNeighborRows({});
      setEditingDraftId(null);
      setAiReview({ expanded: false, open: false, running: false, text: "" });
      await Promise.all([refreshHistory(), refreshLogs()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshGithubActivity() {
    if (review == null) return;
    setRefreshingActivity(true);
    setError(null);
    try {
      const data = await api<OpenResponse>("/api/pr/activity", { method: "POST", body: JSON.stringify({ input: review.pr.url }) });
      setReview(data);
      setOpenFiles((current) => ({ ...Object.fromEntries(data.files.map((file) => [file.filename, !data.fileReviews.find((state) => state.path === file.filename)?.viewed])), ...current }));
      await Promise.all([refreshHistory(), refreshLogs()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingActivity(false);
    }
  }

  async function setViewed(file: PullFile, viewed: boolean) {
    if (review == null) return;
    const fileReview = review.fileReviews.find((state) => state.path === file.filename);
    if (fileReview == null) return;
    await api("/api/file/viewed", { method: "POST", body: JSON.stringify({ ...fileReview, viewed }) });
    setReview({ ...review, fileReviews: review.fileReviews.map((state) => state.path === file.filename ? { ...state, viewed } : state) });
    setOpenFiles({ ...openFiles, [file.filename]: !viewed });
  }

  function pruneEmptyThreads() {
    setThreads((current) => Object.fromEntries(Object.entries(current).filter(([, thread]) => thread.draft.trim().length > 0 || thread.messages.length > 0)));
    setActiveTarget(null);
  }

  function openThread(target: Target) {
    const key = targetKey(target);
    const existing = threads[key];
    const nextThreads = Object.fromEntries(Object.entries(threads).filter(([threadKey, thread]) => threadKey === key || thread.draft.trim().length > 0 || thread.messages.length > 0));
    if (existing != null && existing.draft.trim().length === 0 && existing.messages.length === 0) {
      delete nextThreads[key];
      setThreads(nextThreads);
      setActiveTarget(target);
      return;
    }
    nextThreads[key] = existing == null ? { key, target, collapsed: false, draft: "", messages: [] } : { ...existing, collapsed: !existing.collapsed };
    setThreads(nextThreads);
    setActiveTarget(target);
  }

  function rangeTarget(start: Target, end: Target): Target {
    if (start.path !== end.path || start.side !== end.side || start.line == null || end.line == null) return end;
    return { ...end, startLine: Math.min(start.startLine ?? start.line, end.line), line: Math.max(start.line, end.line) };
  }

  function toggleThread(target: Target, extend = false) {
    if (extend && activeTarget != null) openThread(rangeTarget(activeTarget, target));
    else openThread(target);
  }

  function beginDrag(target: Target) {
    draggedRef.current = false;
    suppressClickRef.current = false;
    const selection = { start: target, current: target, dragging: true };
    dragSelectionRef.current = selection;
    setDragSelection(selection);
  }

  function updateDrag(target: Target) {
    const selection = dragSelectionRef.current;
    if (selection == null || selection.start.path !== target.path || selection.start.side !== target.side) return;
    if (selection.current.line !== target.line) draggedRef.current = true;
    const nextSelection = { ...selection, current: target };
    dragSelectionRef.current = nextSelection;
    setDragSelection(nextSelection);
  }

  function finishDrag(target: Target) {
    const selection = dragSelectionRef.current;
    dragSelectionRef.current = null;
    setDragSelection(null);
    if (selection == null) return;
    suppressClickRef.current = true;
    openThread(rangeTarget(selection.start, target));
  }

  function handleRowClick(target: Target, extend: boolean) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    toggleThread(target, extend);
  }

  async function askThread(thread: Thread) {
    if (review == null || thread.draft.trim().length === 0) return;
    const question = thread.draft.trim();
    setThreads((current) => ({ ...current, [thread.key]: { ...thread, asking: true, draft: "", messages: [...thread.messages, { role: "user", text: question }] } }));
    try {
      const prompt = `Review PR ${review.pr.key}. File: ${thread.target.path}. Lines: ${thread.target.line == null ? "file" : thread.target.startLine != null && thread.target.startLine !== thread.target.line ? `${thread.target.startLine}-${thread.target.line}` : thread.target.line}. Side: ${thread.target.side}. Hunk: ${thread.target.hunk}\n\nQuestion: ${question}`;
      const { answer } = await api<{ answer: string }>("/api/ask", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], asking: false, messages: [...(current[thread.key]?.messages ?? []), { role: "pi", text: answer }] } }));
      await refreshLogs();
    } catch (err) {
      setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], asking: false, messages: [...(current[thread.key]?.messages ?? []), { role: "pi", text: `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}` }] } }));
    }
  }

  async function submitReview(event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) {
    if (review == null || submitting) return;
    setSubmitting(true);
    try {
      await api("/api/review/submit", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, event, body, comments: drafts.filter((draft) => draft.line != null).map(({ path, line, startLine, side, body }) => ({ path, line, side, body, ...(startLine != null && startLine !== line ? { start_line: startLine, start_side: side } : {}) })) }) });
      setDrafts([]);
      await openPr(review.pr.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function expandNeighbor(file: PullFile, key: string, startLine: number, endLine: number) {
    if (review == null) return;
    const { text } = await api<{ text: string }>("/api/file/text", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, path: file.filename, sha: review.pr.headSha }) });
    setExpandedNeighborRows((current) => ({ ...current, [key]: contextRowsFromText(text, startLine, endLine) }));
  }

  async function runAiReview() {
    if (review == null || aiReview.running) return;
    setAiReview({ ...aiReview, open: true, running: true });
    const diffSummary = review.files.map((file) => `## ${file.filename}\n${file.patch ?? "Patch unavailable"}`).join("\n\n");
    const prompt = `Run a concise code review for ${review.pr.key}. Focus on correctness, edge cases, tests, and concrete actionable findings. Avoid generic praise. Return markdown with bullets and file/line references where possible.\n\n${diffSummary}`;
    try {
      const { answer } = await api<{ answer: string }>("/api/ask", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      setAiReview((current) => ({ ...current, open: true, running: false, text: answer }));
    } catch (err) {
      setAiReview((current) => ({ ...current, open: true, running: false, text: `AI review failed: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  async function loadDiagnostics() {
    if (review == null) return null;
    const data = await api<{ diagnostics: Record<string, unknown> }>("/api/pi/diagnostics", { method: "POST", body: JSON.stringify({ prKey: review.pr.key }) });
    setDiagnostics(data.diagnostics);
    return data.diagnostics;
  }

  async function showDiagnostics() {
    await loadDiagnostics();
  }

  async function cleanupPr(pr: StoredPullRequest) {
    if (!confirm(`Remove ${pr.key} from history and delete its local worktree/session cache?`)) return;
    setError(null);
    try {
      await api("/api/pr/cleanup", { method: "POST", body: JSON.stringify({ input: pr.url || prUrlFromKey(pr.key) }) });
      setPrs((current) => current.filter((item) => item.key !== pr.key));
      if (review?.pr.key === pr.key) setReview(null);
      await refreshLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function goHome() {
    setReview(null);
    setError(null);
    setDiagnostics(null);
    void refreshHistory();
  }

  function submit(event: FormEvent) { event.preventDefault(); void openPr(input); }

  return <main className="app-shell"><header className="toolbar"><div><strong>Pi PR Review</strong><span>{review == null ? "Paste a PR to start" : `${review.pr.key} · ${review.pr.title}`}</span></div><div className="toolbar-actions">{review != null && <><button type="button" onClick={goHome}>Home</button><button type="button" title="Pi session settings" onClick={() => { setSettingsOpen(true); void loadDiagnostics(); }}>⚙</button><button type="button" title="Pi session diagnostics" onClick={() => void showDiagnostics()}>🐞</button><select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeName)}><option value="github-dark">GitHub dark</option><option value="github-dimmed">GitHub dimmed</option><option value="github-light">GitHub light</option></select></>}<form className="open-form" onSubmit={submit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="OWNER/REPO#123 or GitHub PR URL" /><button disabled={busy || input.trim().length === 0}>{busy ? "Fetching…" : "Open"}</button></form></div></header>{error != null && <div className="error">{error}</div>}{review == null ? <StartPage prs={prs} logs={logs} openPr={openPr} cleanupPr={cleanupPr} /> : <ReviewPage review={review} openFiles={openFiles} setOpenFiles={setOpenFiles} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} threads={threads} setThreads={setThreads} toggleThread={toggleThread} setViewed={setViewed} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} sideWidth={sideWidth} setSideWidth={setSideWidth} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} aiReview={aiReview} setAiReview={setAiReview} runAiReview={runAiReview} submitReview={submitReview} submitting={submitting} refreshGithubActivity={refreshGithubActivity} refreshingActivity={refreshingActivity} />}{diagnostics != null && !settingsOpen && <DiagnosticsModal diagnostics={diagnostics} close={() => setDiagnostics(null)} />}{review != null && settingsOpen && <PiSettingsModal prKey={review.pr.key} diagnostics={diagnostics} setDiagnostics={setDiagnostics} close={() => setSettingsOpen(false)} />}</main>;
}

function StartPage({ prs, logs, openPr, cleanupPr }: { prs: StoredPullRequest[]; logs: LogEntry[]; openPr: (input: string) => Promise<void>; cleanupPr: (pr: StoredPullRequest) => Promise<void> }) { return <div className="start-grid"><section className="panel"><h1>Previous reviews</h1><p className="muted">Reopen a tracked PR or paste a new one above.</p><History prs={prs} openPr={openPr} cleanupPr={cleanupPr} /></section><details className="panel logs"><summary>Server log</summary><LogRows logs={logs} /></details></div>; }

function ReviewPage(props: DiffProps & { aiReview: AiReview; setAiReview: (review: AiReview) => void; runAiReview: () => Promise<void>; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<void>; submitting: boolean; refreshGithubActivity: () => Promise<void>; refreshingActivity: boolean }) {
  return <div className="review-layout" style={{ gridTemplateColumns: `minmax(0, 1fr) 12px ${props.sideWidth}px` }}><main className="files">{props.review.files.map((file) => <FileDiff key={file.filename} file={file} {...props} />)}</main><div className="resize-handle" role="separator" aria-label="Resize side panel" onMouseDown={(event) => startResizeSidePanel(event, props.sideWidth, props.setSideWidth)} /><aside className="side"><ReviewSummary pr={props.review.pr} drafts={props.drafts} setDrafts={props.setDrafts} editingDraftId={props.editingDraftId} setEditingDraftId={props.setEditingDraftId} submitReview={props.submitReview} submitting={props.submitting} refreshGithubActivity={props.refreshGithubActivity} refreshingActivity={props.refreshingActivity} /><AiReviewPanel review={props.aiReview} setReview={props.setAiReview} runReview={props.runAiReview} /><ExistingComments comments={props.review.comments} issueComments={props.review.issueComments} /></aside></div>;
}

function startResizeSidePanel(event: React.MouseEvent, initialWidth: number, setSideWidth: (width: number) => void): void {
  event.preventDefault();
  const startX = event.clientX;
  function move(moveEvent: MouseEvent) {
    const nextWidth = Math.min(900, Math.max(300, initialWidth - (moveEvent.clientX - startX)));
    setSideWidth(nextWidth);
  }
  function stop() {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", stop);
  }
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
}

function FileDiff({ file, review, openFiles, setOpenFiles, expandedContext, setExpandedContext, expandedNeighborRows, expandNeighbor, threads, setThreads, toggleThread, setViewed, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick }: DiffProps & { file: PullFile }) {
  const rows = useMemo(() => parsePatchRows(file.patch), [file.patch]);
  const fileReview = review.fileReviews.find((state) => state.path === file.filename);
  const open = openFiles[file.filename] ?? true;
  return <section className="file"><button className="file-summary" onClick={() => setOpenFiles({ ...openFiles, [file.filename]: !open })}><div><strong>{file.filename}</strong><span>{file.status} · +{file.additions} / -{file.deletions}</span></div><span>{open ? "Collapse" : "Expand"}</span></button>{open && <><div className="file-actions"><button onClick={() => void setViewed(file, !(fileReview?.viewed ?? false))}>{fileReview?.viewed ? "Mark unviewed" : "Mark viewed"}</button>{fileReview?.viewed && <span className="ok">Viewed. It will start collapsed until this patch changes.</span>}</div><div className="patch">{rows.length === 0 ? <DiffRowView row={{ kind: "meta", oldLine: null, newLine: null, text: "Patch unavailable. Click to attach a file-level note.", hunk: "" }} target={{ path: file.filename, line: null, side: "RIGHT", hunk: "" }} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={review.comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} /> : <FoldedRows file={file} rows={rows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} />}</div></>}</section>;
}

function hunkNewStart(row: DiffRow): number | null {
  const match = row.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return match == null ? null : Number.parseInt(match[1], 10);
}

function contextRowsFromText(fileText: string | undefined, startLine: number, endLine: number): DiffRow[] {
  if (fileText == null || endLine < startLine) return [];
  const lines = fileText.split("\n");
  const rows: DiffRow[] = [];
  for (let line = Math.max(1, startLine); line <= Math.min(endLine, lines.length); line += 1) {
    rows.push({ kind: "context expanded-context", oldLine: line, newLine: line, text: ` ${lines[line - 1] ?? ""}`, hunk: "" });
  }
  return rows;
}

function lastNewLine(rows: DiffRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].newLine != null) return rows[index].newLine;
  }
  return null;
}

function FoldedRows({ file, rows, comments, threads, setThreads, toggleThread, expandedNeighborRows, expandNeighbor, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick }: { file: PullFile; rows: DiffRow[]; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; expandedContext: Record<string, boolean>; setExpandedContext: (expanded: Record<string, boolean>) => void; expandedNeighborRows: Record<string, DiffRow[]>; expandNeighbor: (file: PullFile, key: string, startLine: number, endLine: number) => Promise<void>; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void }) {
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== "hunk") {
      rendered.push(<ConnectedRow key={`${file.filename}:${index}`} file={file} row={rows[index]} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} />);
      continue;
    }

    const nextHunkOffset = rows.slice(index + 1).findIndex((row) => row.kind === "hunk");
    const blockEnd = nextHunkOffset === -1 ? rows.length : index + 1 + nextHunkOffset;
    const block = rows.slice(index, blockEnd);
    const start = hunkNewStart(rows[index]);
    const lastLine = lastNewLine(block);

    if (start != null) {
      const aboveKey = `${file.filename}:${index}:above`;
      rendered.push(<button className="fold neighbor" key={`${aboveKey}:button`} onClick={() => void expandNeighbor(file, aboveKey, Math.max(1, start - (expandedNeighborRows[aboveKey]?.length ?? 0) - 10), start - 1)}>Expand above</button>);
      (expandedNeighborRows[aboveKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${aboveKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} />));
    }

    block.forEach((row, offset) => rendered.push(<ConnectedRow key={`${file.filename}:${index + offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} />));

    if (lastLine != null) {
      const belowKey = `${file.filename}:${index}:below`;
      (expandedNeighborRows[belowKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${belowKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} />));
      rendered.push(<button className="fold neighbor" key={`${belowKey}:button`} onClick={() => void expandNeighbor(file, belowKey, lastLine + 1, lastLine + (expandedNeighborRows[belowKey]?.length ?? 0) + 10)}>Expand below</button>);
    }
    index = blockEnd - 1;
  }
  return <>{rendered}</>;
}

function ConnectedRow({ file, row, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick }: { file: PullFile; row: DiffRow; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void }) {
  const line = row.newLine ?? row.oldLine;
  const target = line == null || row.kind === "hunk" || row.kind === "meta" ? null : { path: file.filename, line, side: row.newLine != null ? "RIGHT" as const : "LEFT" as const, hunk: row.hunk };
  return <DiffRowView row={row} target={target} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} />;
}

function updateDraft(drafts: DraftComment[], setDrafts: (drafts: DraftComment[]) => void, id: string, body: string): void {
  setDrafts(drafts.map((draft) => draft.id === id ? { ...draft, body } : draft));
}

function DraftView({ draft, drafts, setDrafts, editingDraftId, setEditingDraftId }: { draft: DraftComment; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void }) {
  const editing = editingDraftId === draft.id;
  return <div className="comment draft-card"><div className="thread-head"><span>{targetLabel(draft)}</span><div className="actions"><button title="Edit draft" onClick={() => setEditingDraftId(editing ? null : draft.id)}>✎</button><button onClick={() => setDrafts(drafts.filter((item) => item.id !== draft.id))}>Remove</button></div></div>{editing ? <textarea value={draft.body} onChange={(event) => updateDraft(drafts, setDrafts, draft.id, event.target.value)} /> : <p>{draft.body}</p>}</div>;
}

function DiffRowView({ row, target, threads, setThreads, toggleThread, comments, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick }: { row: DiffRow; target: Target | null; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; comments: PullReviewComment[]; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void }) {
  const thread = target == null ? null : threadForTarget(threads, target);
  const inlineComments = target == null ? [] : comments.filter((comment) => comment.path === target.path && targetKey(commentTarget(comment)) === targetKey(target));
  const inlineDrafts = target == null ? [] : drafts.filter((draft) => draftMatchesTarget(draft, target));
  const selecting = isTargetInSelection(target, dragSelection);
  return <><div className={`diff-row ${row.kind} ${thread != null && !thread.collapsed ? "selected" : ""} ${selecting ? "range-selecting" : ""}`} data-path={target?.path} data-line={target?.line ?? undefined} data-side={target?.side} data-hunk={target?.hunk} onMouseDown={(event) => { if (target != null && event.button === 0) { event.preventDefault(); beginDrag(target); } }} onMouseEnter={() => { if (target != null && dragSelectionRef.current != null) updateDrag(target); }} onMouseUp={() => { if (target != null) finishDrag(target); }} onClick={(event) => { if (target != null) handleRowClick(target, event.shiftKey); }}><span className="num">{row.oldLine ?? ""}</span><span className="num">{row.newLine ?? ""}</span><CodeText code={row.text} language={languageForPath(target?.path)} />{(thread != null || inlineComments.length + inlineDrafts.length > 0) && <span className="pill">{(thread == null ? 0 : 1) + inlineComments.length + inlineDrafts.length}</span>}</div>{inlineComments.map((comment) => <div className="inline-thread existing" key={comment.id}><strong>@{comment.user?.login ?? "github"}</strong><MarkdownText text={comment.body} /><a href={comment.html_url} target="_blank" rel="noreferrer">Open comment</a></div>)}{inlineDrafts.map((draft) => <div className="inline-thread draft" key={draft.id}><DraftView draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} /></div>)}{thread != null && <ThreadBox thread={thread} setThread={(next) => setThreads((current) => ({ ...current, [next.key]: next }))} closeThread={() => setThreads((current) => { const next = { ...current }; delete next[thread.key]; return next; })} addDraft={() => { if (thread.draft.trim().length > 0) setDrafts([...drafts, { id: newId(), path: thread.target.path, line: thread.target.line, startLine: thread.target.startLine, side: thread.target.side, body: thread.draft.trim() }]); setThreads((current) => { const next = { ...current }; if (thread.messages.length === 0) delete next[thread.key]; else next[thread.key] = { ...thread, draft: "", collapsed: true }; return next; }); }} askThread={askThread} />}</>;
}

function ThreadBox({ thread, setThread, closeThread, addDraft, askThread }: { thread: Thread; setThread: (thread: Thread) => void; closeThread: () => void; addDraft: () => void; askThread: (thread: Thread) => Promise<void> }) {
  if (thread.collapsed) return <button className="inline-thread collapsed" onClick={() => setThread({ ...thread, collapsed: false })}>▶ Thread on {thread.target.line == null ? "file" : targetLabel(thread.target)}</button>;
  return <div className="inline-thread review-thread"><div className="thread-head"><div><strong>Line thread</strong><span>{targetLabel(thread.target)}</span></div><div className="actions">{(thread.draft.trim().length > 0 || thread.messages.length > 0) && <button onClick={() => setThread({ ...thread, collapsed: true })}>Collapse</button>}<button onClick={closeThread}>Close</button></div></div>{thread.target.line != null && <label className="range-control">Range end <input type="number" value={thread.target.line} min={thread.target.startLine ?? thread.target.line} onChange={(event) => setThread({ ...thread, target: { ...thread.target, startLine: thread.target.startLine ?? thread.target.line, line: Number.parseInt(event.target.value, 10) || thread.target.line } })} /></label>}{thread.messages.length > 0 && <div className="thread-messages">{thread.messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} /></div>)}</div>}<div className="composer"><textarea value={thread.draft} onChange={(event) => setThread({ ...thread, draft: event.target.value })} placeholder="Write a draft comment or ask Pi about this line" /><div className="actions"><button onClick={addDraft} disabled={thread.draft.trim().length === 0}>Add draft comment</button><button onClick={() => void askThread(thread)} disabled={thread.asking || thread.draft.trim().length === 0}>{thread.asking ? "Asking…" : "Ask Pi"}</button></div></div></div>;
}

function MarkdownText({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>{text}</ReactMarkdown></div>;
}

function MarkdownCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const code = String(children ?? "").replace(/\n$/, "");
  const language = className?.match(/language-(\w+)/)?.[1] ?? "";
  return <code dangerouslySetInnerHTML={{ __html: highlightedHtml(code, language) }} />;
}

function ReviewSummary({ pr, drafts, setDrafts, editingDraftId, setEditingDraftId, submitReview, submitting, refreshGithubActivity, refreshingActivity }: { pr: StoredPullRequest; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<void>; submitting: boolean; refreshGithubActivity: () => Promise<void>; refreshingActivity: boolean }) {
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  return <section className="panel"><h2>{pr.title}</h2><div className="meta"><span>{pr.key}</span><span>{pr.state}</span><span>{pr.filesChanged} files</span><span>{pr.existingCommentCount} comments</span><span>head {shortSha(pr.headSha)}</span></div><div className="link-row"><a href={pr.url} target="_blank" rel="noreferrer">Open GitHub</a><button onClick={() => void refreshGithubActivity()} disabled={refreshingActivity}>{refreshingActivity ? "Fetching…" : "Fetch GitHub activity"}</button></div><h2>Draft review</h2><select value={event} onChange={(change) => setEvent(change.target.value as typeof event)}><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><textarea value={body} onChange={(change) => setBody(change.target.value)} placeholder="Overall review body" />{drafts.length === 0 ? <p className="muted">No draft comments yet.</p> : drafts.map((draft) => <DraftView key={draft.id} draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} />)}<button disabled={submitting || (body.trim().length === 0 && drafts.length === 0)} onClick={() => void submitReview(event, body)}>{submitting ? "Submitting…" : `Submit review (${drafts.length})`}</button></section>;
}

function AiReviewPanel({ review, setReview, runReview }: { review: AiReview; setReview: (review: AiReview) => void; runReview: () => Promise<void> }) {
  const body = review.text.length > 0 ? <MarkdownText text={review.text} /> : <p className="muted">Run the PR review skill-style prompt and show the result here.</p>;
  return <><section className="panel ai-review"><div className="thread-head"><h2>Pi review</h2><div className="actions"><button onClick={() => setReview({ ...review, expanded: true, open: true })} disabled={review.text.length === 0 && !review.open}>Expand</button><button onClick={() => setReview({ ...review, open: !review.open })}>{review.open ? "Hide" : "Show"}</button></div></div><button onClick={() => void runReview()} disabled={review.running}>{review.running ? "Reviewing…" : review.text.length > 0 ? "Run again" : "Run review"}</button>{review.open && body}</section>{review.expanded && <div className="review-modal" role="dialog" aria-modal="true"><div className="review-modal-card"><div className="thread-head"><h2>Pi review</h2><div className="actions"><button onClick={() => void runReview()} disabled={review.running}>{review.running ? "Reviewing…" : "Run again"}</button><button onClick={() => setReview({ ...review, expanded: false })}>Close</button></div></div><div className="review-modal-body">{body}</div></div></div>}</>;
}

function ExistingComments({ comments, issueComments }: { comments: PullReviewComment[]; issueComments: PullIssueComment[] }) { return <section className="panel"><h2>Existing comments</h2>{comments.length + issueComments.length === 0 ? <p className="muted">No existing comments.</p> : <>{issueComments.map((comment) => <div className="comment" key={`issue-${comment.id}`}><a href={comment.html_url} target="_blank" rel="noreferrer"><span>Conversation</span></a><strong>@{comment.user?.login ?? "github"}</strong><MarkdownText text={comment.body} /></div>)}{comments.map((comment) => <div className="comment" key={comment.id}><a href={comment.html_url} target="_blank" rel="noreferrer"><span>{comment.path}:{comment.line ?? comment.original_line ?? "?"}</span></a><strong>@{comment.user?.login ?? "github"}</strong><MarkdownText text={comment.body} /></div>)}</>}</section>; }

function diagnosticsText(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function diagnosticsArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function DiagnosticsView({ diagnostics }: { diagnostics: Record<string, unknown> | null }) {
  if (diagnostics == null) return <p className="muted">Loading Pi diagnostics…</p>;
  const activeTools = diagnosticsArray(diagnostics.activeTools);
  const tools = diagnosticsArray(diagnostics.tools);
  const models = diagnosticsArray(diagnostics.availableModels);
  const lastPrompt = diagnostics.lastPrompt as { chars?: number; preview?: string; startedAt?: string } | null;
  return <div className="diagnostics-view"><div className="diagnostics-grid"><div><span>Model</span><strong>{diagnosticsText(diagnostics.model)}</strong></div><div><span>Thinking</span><strong>{diagnosticsText(diagnostics.thinkingLevel)}</strong></div><div><span>Active tools</span><strong>{activeTools.length}</strong></div><div><span>Available models</span><strong>{models.length}</strong></div></div><section><h3>Session</h3><dl><dt>PR key</dt><dd>{diagnosticsText(diagnostics.prKey)}</dd><dt>CWD</dt><dd>{diagnosticsText(diagnostics.cwd)}</dd><dt>Session file</dt><dd>{diagnosticsText(diagnostics.sessionFile)}</dd><dt>Session ID</dt><dd>{diagnosticsText(diagnostics.sessionId)}</dd></dl></section><section><h3>Last prompt</h3>{lastPrompt == null ? <p className="muted">No prompt sent yet.</p> : <><p className="muted">{lastPrompt.chars ?? 0} chars · {lastPrompt.startedAt ?? "unknown time"}</p><pre className="prompt-preview">{lastPrompt.preview}</pre></>}</section><details open><summary>Active tools ({activeTools.length})</summary><div className="chip-list">{activeTools.map((tool, index) => <span className="chip" key={index}>{diagnosticsText(tool)}</span>)}</div></details><details><summary>Available models ({models.length})</summary><div className="model-list">{models.map((model, index) => <code key={index}>{diagnosticsText(model)}</code>)}</div></details><details><summary>All tool definitions ({tools.length})</summary><div className="model-list">{tools.map((tool, index) => <code key={index}>{diagnosticsText(tool)}</code>)}</div></details><details><summary>Raw diagnostics</summary><pre className="diagnostics-json">{JSON.stringify(diagnostics, null, 2)}</pre></details></div>;
}

function DiagnosticsModal({ diagnostics, close }: { diagnostics: Record<string, unknown>; close: () => void }) { return <div className="review-modal" role="dialog" aria-modal="true"><div className="review-modal-card"><div className="thread-head"><h2>Pi diagnostics</h2><button onClick={close}>Close</button></div><DiagnosticsView diagnostics={diagnostics} /></div></div>; }

function PiSettingsModal({ prKey, diagnostics, setDiagnostics, close }: { prKey: string; diagnostics: Record<string, unknown> | null; setDiagnostics: (diagnostics: Record<string, unknown>) => void; close: () => void }) {
  const models = Array.isArray(diagnostics?.availableModels) ? diagnostics.availableModels as Array<{ provider?: string; id?: string; name?: string }> : [];
  const currentModel = typeof diagnostics?.model === "string" ? diagnostics.model : "";
  const [selected, setSelected] = useState(currentModel.includes("/") ? currentModel : "");
  const [thinkingLevel, setThinkingLevel] = useState(typeof diagnostics?.thinkingLevel === "string" ? diagnostics.thinkingLevel : "");
  async function apply() {
    const [provider, ...rest] = selected.split("/");
    const modelId = rest.join("/");
    if (provider.length === 0 || modelId.length === 0) return;
    const data = await api<{ diagnostics: Record<string, unknown> }>("/api/pi/model", { method: "POST", body: JSON.stringify({ prKey, provider, modelId, thinkingLevel }) });
    setDiagnostics(data.diagnostics);
  }
  return <div className="review-modal" role="dialog" aria-modal="true"><div className="review-modal-card"><div className="thread-head"><h2>Pi settings</h2><button onClick={close}>Close</button></div><label>Model<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Select model…</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.provider}/{model.id}{model.name != null ? ` · ${model.name}` : ""}</option>)}</select></label><label>Thinking<select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}><option value="">Keep current</option>{["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label><button onClick={() => void apply()} disabled={selected.length === 0}>Apply to this PR session</button><DiagnosticsView diagnostics={diagnostics} /></div></div>;
}
function History({ prs, openPr, cleanupPr }: { prs: StoredPullRequest[]; openPr: (input: string) => Promise<void>; cleanupPr: (pr: StoredPullRequest) => Promise<void> }) { return <div className="history">{prs.length === 0 ? <p className="muted">No previous PRs.</p> : prs.map((pr) => <div className="history-row" key={pr.key}><button onClick={() => void openPr(pr.url)}><strong>{pr.title}</strong><span>{pr.key} · {pr.filesChanged ?? "—"} files · {pr.existingCommentCount ?? "—"} comments</span></button><button className="trash-button" title="Remove saved PR and cleanup worktree" onClick={() => void cleanupPr(pr)}>🗑</button></div>)}</div>; }
function LogRows({ logs }: { logs: LogEntry[] }) { return <>{logs.map((log) => <div className={`log ${log.level}`} key={log.id}><span>{new Date(log.timestamp).toLocaleTimeString()} {log.scope}</span><p>{log.message}</p>{log.data !== undefined && <code>{JSON.stringify(log.data)}</code>}</div>)}</>; }

createRoot(document.getElementById("root")!).render(<App />);
