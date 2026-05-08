import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Button } from "./components/Button";
import { CodeText, MarkdownText } from "./components/Markdown";
import { ModalShell } from "./components/Modal";
import { ExistingComments, ExistingReviewThread } from "./components/Threads";
import { commentTarget, draftMatchesTarget, groupReviewComments, targetKey, targetLabel, threadForTarget } from "./lib/comments";
import { contextRowsFromText, hunkNewStart, isTargetInSelection, lastNewLine, parsePatchRows, targetFromPoint, targetFromRow } from "./lib/diff";
import { languageForPath } from "./lib/highlight";
import { newId, prUrlFromKey, shortSha } from "./lib/pr";
import type { AiReview, DiffRow, DraftComment, DragSelection, FileReviewState, FocusArea, FocusReview, LogEntry, OpenResponse, PullFile, PullIssueComment, PullReviewComment, StoredPullRequest, Target, ThemeName, Thread } from "./types";
import "./styles.css";

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
  refreshGithubActivity: () => Promise<void>;
  commentCollapseSignal: number;
  collapseAllComments: () => void;
  focusAreas: FocusArea[];
  activeFocusAreaId: string | null;
  setActiveFocusAreaId: (id: string | null) => void;
};

function parseFocusAreas(text: string): FocusArea[] {
  const location = /(?:^|[`\s(*-])([\w./@+-][\w./@+ -]*?\.[\w+-]+):(\d+)(?:-(\d+))?(?:\s*[—-]\s*([^\n]+))?/gm;
  const areas: FocusArea[] = [];
  for (const match of text.matchAll(location)) {
    const path = match[1].trim();
    const startLine = Number.parseInt(match[2], 10);
    const endLine = Number.parseInt(match[3] ?? match[2], 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
    areas.push({ id: `${path}:${startLine}-${endLine}:${areas.length}`, path, startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine), title: (match[4] ?? "Focus area").replace(/[`*_]+$/g, "").trim(), body: nearbyMarkdown(text, match.index ?? 0) });
  }
  return areas;
}

function nearbyMarkdown(text: string, index: number): string {
  const nextItem = text.slice(index + 1).search(/\n\s*(?:[-*]|\d+\.)\s+[`\w./@+-][^\n]*:\d+/);
  const end = nextItem === -1 ? text.length : index + 1 + nextItem;
  return text.slice(index, end).trim();
}

function highlightFocusAreas(areas: FocusArea[], activeId: string | null): void {
  document.querySelectorAll(".diff-row.focus-highlight, .diff-row.focus-highlight-active").forEach((row) => row.classList.remove("focus-highlight", "focus-highlight-active"));
  for (const area of areas) {
    document.querySelectorAll<HTMLElement>(".diff-row[data-path][data-line]").forEach((row) => {
      const line = Number.parseInt(row.dataset.line ?? "", 10);
      if (row.dataset.path !== area.path || !Number.isFinite(line) || line < area.startLine || line > area.endLine) return;
      row.classList.add("focus-highlight");
      if (area.id === activeId) row.classList.add("focus-highlight-active");
    });
  }
  if (activeId != null) document.querySelector(".diff-row.focus-highlight-active")?.scrollIntoView({ block: "center", behavior: "smooth" });
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
  const [aiReview, setAiReview] = useState<AiReview>({ expanded: false, open: false, running: false, text: "", messages: [] });
  const [focusReview, setFocusReview] = useState<FocusReview>({ expanded: false, open: false, running: false, text: "" });
  const [activeFocusAreaId, setActiveFocusAreaId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sideWidth, setSideWidth] = useState(380);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => localStorage.getItem("pi-review-theme") as ThemeName || "github-dark");
  const [commentCollapseSignal, setCommentCollapseSignal] = useState(0);

  async function refreshHistory() { setPrs((await api<{ prs: StoredPullRequest[] }>("/api/prs")).prs); }
  async function refreshLogs() { setLogs((await api<{ logs: LogEntry[] }>("/api/logs")).logs.slice(-40).reverse()); }

  useEffect(() => { refreshHistory().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); refreshLogs().catch(() => undefined); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pi-review-theme", theme);
  }, [theme]);

  const focusAreas = useMemo(() => parseFocusAreas(focusReview.text), [focusReview.text]);
  useEffect(() => highlightFocusAreas(focusAreas, activeFocusAreaId), [focusAreas, activeFocusAreaId, openFiles, expandedNeighborRows]);

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
      setAiReview({ expanded: false, open: false, running: false, text: "", messages: [] });
      setFocusReview({ expanded: false, open: false, running: false, text: "" });
      setActiveFocusAreaId(null);
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
    setAiReview((current) => ({ ...current, open: true, expanded: true, running: true }));
    const diffSummary = review.files.map((file) => `## ${file.filename}\n${file.patch ?? "Patch unavailable"}`).join("\n\n");
    const prompt = `Run a concise code review for ${review.pr.key}. Focus on correctness, edge cases, tests, and concrete actionable findings. Avoid generic praise. Return markdown with bullets and file/line references where possible.\n\n${diffSummary}`;
    try {
      const { answer } = await api<{ answer: string }>("/api/ask", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text: answer, messages: [...current.messages, { role: "pi", text: answer }] }));
    } catch (err) {
      const text = `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text, messages: [...current.messages, { role: "pi", text }] }));
    }
  }

  async function sendAiReviewMessage(message: string) {
    if (review == null || aiReview.running || message.trim().length === 0) return;
    const question = message.trim();
    setAiReview((current) => ({ ...current, open: true, expanded: true, running: true, messages: [...current.messages, { role: "user", text: question }] }));
    try {
      const previous = aiReview.messages.map((entry) => `${entry.role === "user" ? "User" : "Pi"}: ${entry.text}`).join("\n\n");
      const prompt = `Continue discussing PR ${review.pr.key}. Answer the user's latest question using the checked-out PR worktree. Be concise and cite files/lines when useful.\n\nPrevious dialogue:\n${previous || "(none)"}\n\nUser: ${question}`;
      const { answer } = await api<{ answer: string }>("/api/ask", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text: answer, messages: [...current.messages, { role: "pi", text: answer }] }));
    } catch (err) {
      const text = `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text, messages: [...current.messages, { role: "pi", text }] }));
    }
  }

  async function runFocusReview() {
    if (review == null || focusReview.running) return;
    setFocusReview((current) => ({ ...current, open: true, running: true }));
    const diffSummary = review.files.map((file) => `## ${file.filename}\nStatus: ${file.status}, +${file.additions}/-${file.deletions}\n${file.patch ?? "Patch unavailable"}`).join("\n\n");
    const prompt = `You are a second, independent PR-review pass for ${review.pr.key}. Look specifically for areas worth deeper human review, not a normal exhaustive review. Prioritize:\n- code that feels inconsistent with nearby codebase patterns or API conventions\n- surprising behavior, hidden assumptions, edge cases, or subtle tradeoffs\n- tests, migrations, performance, concurrency, or compatibility risks that deserve investigation\n- places where the implementation may be valid but reviewers should explicitly decide if the tradeoff is acceptable\n\nReturn markdown with a short "Focus areas" list. Start each item with a clickable-style location in this exact format: \`path:startLine-endLine — short title\` or \`path:line — short title\`. Then include why it is weird or worth investigation and a concrete reviewer question. Avoid generic praise and avoid blocking language unless there is strong evidence.\n\nPR title: ${review.pr.title}\n\n${diffSummary}`;
    try {
      const { answer } = await api<{ answer: string }>("/api/pi/focus-review", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      setFocusReview((current) => ({ ...current, open: true, running: false, text: answer }));
      setActiveFocusAreaId(parseFocusAreas(answer)[0]?.id ?? null);
    } catch (err) {
      const text = `Focus review failed: ${err instanceof Error ? err.message : String(err)}`;
      setFocusReview((current) => ({ ...current, open: true, running: false, text }));
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

  return <main className="app-shell"><header className="toolbar"><div><strong>Pi PR Review</strong><span>{review == null ? "Paste a PR to start" : `${review.pr.key} · ${review.pr.title}`}</span></div><div className="toolbar-actions">{review != null && <><button type="button" onClick={goHome}>Home</button><button type="button" title="Pi session settings" onClick={() => { setSettingsOpen(true); void loadDiagnostics(); }}>⚙</button><button type="button" title="Pi session diagnostics" onClick={() => void showDiagnostics()}>🐞</button><select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeName)}><option value="github-dark">GitHub dark</option><option value="github-dimmed">GitHub dimmed</option><option value="github-light">GitHub light</option></select></>}<form className="open-form" onSubmit={submit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="OWNER/REPO#123 or GitHub PR URL" /><button disabled={busy || input.trim().length === 0}>{busy ? "Fetching…" : "Open"}</button></form></div></header>{error != null && <div className="error">{error}</div>}{review == null ? <StartPage prs={prs} logs={logs} openPr={openPr} cleanupPr={cleanupPr} /> : <ReviewPage review={review} openFiles={openFiles} setOpenFiles={setOpenFiles} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} threads={threads} setThreads={setThreads} toggleThread={toggleThread} setViewed={setViewed} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} sideWidth={sideWidth} setSideWidth={setSideWidth} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} commentCollapseSignal={commentCollapseSignal} collapseAllComments={() => setCommentCollapseSignal((signal) => signal + 1)} aiReview={aiReview} setAiReview={setAiReview} runAiReview={runAiReview} sendAiReviewMessage={sendAiReviewMessage} focusReview={focusReview} setFocusReview={setFocusReview} runFocusReview={runFocusReview} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} submitReview={submitReview} submitting={submitting} refreshGithubActivity={refreshGithubActivity} refreshingActivity={refreshingActivity} />}{diagnostics != null && !settingsOpen && <DiagnosticsModal diagnostics={diagnostics} close={() => setDiagnostics(null)} />}{review != null && settingsOpen && <PiSettingsModal prKey={review.pr.key} diagnostics={diagnostics} setDiagnostics={setDiagnostics} close={() => setSettingsOpen(false)} />}</main>;
}

function StartPage({ prs, logs, openPr, cleanupPr }: { prs: StoredPullRequest[]; logs: LogEntry[]; openPr: (input: string) => Promise<void>; cleanupPr: (pr: StoredPullRequest) => Promise<void> }) { return <div className="start-grid"><section className="panel"><h1>Previous reviews</h1><p className="muted">Reopen a tracked PR or paste a new one above.</p><History prs={prs} openPr={openPr} cleanupPr={cleanupPr} /></section><details className="panel logs"><summary>Server log</summary><LogRows logs={logs} /></details></div>; }

function ReviewPage(props: DiffProps & { aiReview: AiReview; setAiReview: (review: AiReview) => void; runAiReview: () => Promise<void>; sendAiReviewMessage: (message: string) => Promise<void>; focusReview: FocusReview; setFocusReview: (review: FocusReview) => void; runFocusReview: () => Promise<void>; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<void>; submitting: boolean; refreshingActivity: boolean }) {
  return <div className="review-layout" style={{ gridTemplateColumns: `minmax(0, 1fr) 12px ${props.sideWidth}px` }}><main className="files"><div className="comment-tools"><button className="small-muted-button" onClick={props.collapseAllComments}>Collapse all comments</button></div>{props.review.files.map((file) => <FileDiff key={file.filename} file={file} {...props} />)}</main><div className="resize-handle" role="separator" aria-label="Resize side panel" onMouseDown={(event) => startResizeSidePanel(event, props.sideWidth, props.setSideWidth)} /><aside className="side"><ReviewSummary pr={props.review.pr} drafts={props.drafts} setDrafts={props.setDrafts} editingDraftId={props.editingDraftId} setEditingDraftId={props.setEditingDraftId} submitReview={props.submitReview} submitting={props.submitting} refreshGithubActivity={props.refreshGithubActivity} refreshingActivity={props.refreshingActivity} /><AiReviewPanel review={props.aiReview} setReview={props.setAiReview} runReview={props.runAiReview} sendMessage={props.sendAiReviewMessage} focusReview={props.focusReview} runFocusReview={props.runFocusReview} focusAreaCount={props.focusAreas.length} /><ExistingComments prUrl={props.review.pr.url} comments={props.review.comments} issueComments={props.review.issueComments} refreshGithubActivity={props.refreshGithubActivity} collapseSignal={props.commentCollapseSignal} collapseAllComments={props.collapseAllComments} /></aside></div>;
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

function FileDiff({ file, review, openFiles, setOpenFiles, expandedContext, setExpandedContext, expandedNeighborRows, expandNeighbor, threads, setThreads, toggleThread, setViewed, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, refreshGithubActivity, commentCollapseSignal, focusAreas, activeFocusAreaId, setActiveFocusAreaId }: DiffProps & { file: PullFile }) {
  const rows = useMemo(() => parsePatchRows(file.patch), [file.patch]);
  const fileReview = review.fileReviews.find((state) => state.path === file.filename);
  const open = openFiles[file.filename] ?? true;
  return <section className="file"><button className="file-summary" onClick={() => setOpenFiles({ ...openFiles, [file.filename]: !open })}><div><strong>{file.filename}</strong><span>{file.status} · +{file.additions} / -{file.deletions}</span></div><span>{open ? "Collapse" : "Expand"}</span></button>{open && <><div className="file-actions"><label className="viewed-toggle"><input type="checkbox" checked={fileReview?.viewed ?? false} onChange={(event) => void setViewed(file, event.target.checked)} /> Viewed</label></div><div className="patch">{rows.length === 0 ? <DiffRowView row={{ kind: "meta", oldLine: null, newLine: null, text: "Patch unavailable. Click to attach a file-level note.", hunk: "" }} target={{ path: file.filename, line: null, side: "RIGHT", hunk: "" }} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={review.comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} /> : <FoldedRows file={file} rows={rows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />}</div></>}</section>;
}

function FoldedRows({ file, rows, comments, threads, setThreads, toggleThread, expandedNeighborRows, expandNeighbor, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, focusAreas, activeFocusAreaId, setActiveFocusAreaId }: { file: PullFile; rows: DiffRow[]; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; expandedContext: Record<string, boolean>; setExpandedContext: (expanded: Record<string, boolean>) => void; expandedNeighborRows: Record<string, DiffRow[]>; expandNeighbor: (file: PullFile, key: string, startLine: number, endLine: number) => Promise<void>; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void }) {
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== "hunk") {
      rendered.push(<ConnectedRow key={`${file.filename}:${index}`} file={file} row={rows[index]} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />);
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
      (expandedNeighborRows[aboveKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${aboveKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />));
    }

    block.forEach((row, offset) => rendered.push(<ConnectedRow key={`${file.filename}:${index + offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />));

    if (lastLine != null) {
      const belowKey = `${file.filename}:${index}:below`;
      (expandedNeighborRows[belowKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${belowKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />));
      rendered.push(<button className="fold neighbor" key={`${belowKey}:button`} onClick={() => void expandNeighbor(file, belowKey, lastLine + 1, lastLine + (expandedNeighborRows[belowKey]?.length ?? 0) + 10)}>Expand below</button>);
    }
    index = blockEnd - 1;
  }
  return <>{rendered}</>;
}

function ConnectedRow({ file, row, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, focusAreas, activeFocusAreaId, setActiveFocusAreaId }: { file: PullFile; row: DiffRow; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void }) {
  const line = row.newLine ?? row.oldLine;
  const target = line == null || row.kind === "hunk" || row.kind === "meta" ? null : { path: file.filename, line, side: row.newLine != null ? "RIGHT" as const : "LEFT" as const, hunk: row.hunk };
  return <DiffRowView row={row} target={target} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />;
}

function updateDraft(drafts: DraftComment[], setDrafts: (drafts: DraftComment[]) => void, id: string, body: string): void {
  setDrafts(drafts.map((draft) => draft.id === id ? { ...draft, body } : draft));
}

function DraftView({ draft, drafts, setDrafts, editingDraftId, setEditingDraftId }: { draft: DraftComment; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void }) {
  const editing = editingDraftId === draft.id;
  return <div className="comment draft-card"><div className="thread-head"><span>{targetLabel(draft)}</span><div className="actions"><button title="Edit draft" onClick={() => setEditingDraftId(editing ? null : draft.id)}>✎</button><button onClick={() => setDrafts(drafts.filter((item) => item.id !== draft.id))}>Remove</button></div></div>{editing ? <textarea value={draft.body} onChange={(event) => updateDraft(drafts, setDrafts, draft.id, event.target.value)} /> : <p>{draft.body}</p>}</div>;
}

function DiffRowView({ row, target, threads, setThreads, toggleThread, comments, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, focusAreas, activeFocusAreaId, setActiveFocusAreaId }: { row: DiffRow; target: Target | null; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; comments: PullReviewComment[]; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void }) {
  const thread = target == null ? null : threadForTarget(threads, target);
  const inlineComments = target == null ? [] : comments.filter((comment) => comment.path === target.path && targetKey(commentTarget(comment)) === targetKey(target));
  const inlineCommentThreads = groupReviewComments(inlineComments);
  const inlineDrafts = target == null ? [] : drafts.filter((draft) => draftMatchesTarget(draft, target));
  const selecting = isTargetInSelection(target, dragSelection);
  const rowFocusAreas = target == null ? [] : focusAreas.filter((area) => area.path === target.path && target.line === area.endLine);
  return <><div className={`diff-row ${row.kind} ${thread != null && !thread.collapsed ? "selected" : ""} ${selecting ? "range-selecting" : ""}`} data-path={target?.path} data-line={target?.line ?? undefined} data-side={target?.side} data-hunk={target?.hunk} onMouseDown={(event) => { if (target != null && event.button === 0) { event.preventDefault(); beginDrag(target); } }} onMouseEnter={() => { if (target != null && dragSelection != null) updateDrag(target); }} onMouseUp={() => { if (target != null) finishDrag(target); }} onClick={(event) => { if (target != null) handleRowClick(target, event.shiftKey); }}><span className="num">{row.oldLine ?? ""}</span><span className="num">{row.newLine ?? ""}</span><CodeText code={row.text} language={languageForPath(target?.path)} />{(thread != null || inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length > 0) && <span className="pill">{(thread == null ? 0 : 1) + inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length}</span>}</div>{inlineCommentThreads.map((commentThread) => <ExistingReviewThread key={commentThread.map((comment) => comment.id).join(":")} comments={commentThread} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} />)}{rowFocusAreas.map((area) => <FocusAreaInline key={area.id} area={area} active={area.id === activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} />)}{inlineDrafts.map((draft) => <div className="inline-thread draft" key={draft.id}><DraftView draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} /></div>)}{thread != null && <ThreadBox thread={thread} setThread={(next) => setThreads((current) => ({ ...current, [next.key]: next }))} closeThread={() => setThreads((current) => { const next = { ...current }; delete next[thread.key]; return next; })} addDraft={() => { if (thread.draft.trim().length > 0) setDrafts([...drafts, { id: newId(), path: thread.target.path, line: thread.target.line, startLine: thread.target.startLine, side: thread.target.side, body: thread.draft.trim() }]); setThreads((current) => { const next = { ...current }; if (thread.messages.length === 0) delete next[thread.key]; else next[thread.key] = { ...thread, draft: "", collapsed: true }; return next; }); }} askThread={askThread} />}</>;
}

function FocusAreaInline({ area, active, setActiveFocusAreaId }: { area: FocusArea; active: boolean; setActiveFocusAreaId: (id: string | null) => void }) {
  return <div className={`inline-thread focus-area-inline${active ? " active" : ""}`}><div className="thread-head"><div><strong>Focus area</strong><span>{area.path}:{area.startLine === area.endLine ? area.startLine : `${area.startLine}-${area.endLine}`}</span></div><div className="actions"><button onClick={() => setActiveFocusAreaId(active ? null : area.id)}>{active ? "Unfocus" : "Focus"}</button></div></div><MarkdownText text={area.body} /></div>;
}

function ThreadBox({ thread, setThread, closeThread, addDraft, askThread }: { thread: Thread; setThread: (thread: Thread) => void; closeThread: () => void; addDraft: () => void; askThread: (thread: Thread) => Promise<void> }) {
  if (thread.collapsed) return <button className="inline-thread collapsed" onClick={() => setThread({ ...thread, collapsed: false })}>▶ Thread on {thread.target.line == null ? "file" : targetLabel(thread.target)}</button>;
  return <div className="inline-thread review-thread"><div className="thread-head"><div><strong>Line thread</strong><span>{targetLabel(thread.target)}</span></div><div className="actions">{(thread.draft.trim().length > 0 || thread.messages.length > 0) && <button onClick={() => setThread({ ...thread, collapsed: true })}>Collapse</button>}<button onClick={closeThread}>Close</button></div></div>{thread.target.line != null && <label className="range-control">Range end <input type="number" value={thread.target.line} min={thread.target.startLine ?? thread.target.line} onChange={(event) => setThread({ ...thread, target: { ...thread.target, startLine: thread.target.startLine ?? thread.target.line, line: Number.parseInt(event.target.value, 10) || thread.target.line } })} /></label>}{thread.messages.length > 0 && <div className="thread-messages">{thread.messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} /></div>)}</div>}<div className="composer"><textarea value={thread.draft} onChange={(event) => setThread({ ...thread, draft: event.target.value })} placeholder="Write a draft comment or ask Pi about this line" /><div className="actions"><button onClick={addDraft} disabled={thread.draft.trim().length === 0}>Add draft comment</button><button onClick={() => void askThread(thread)} disabled={thread.asking || thread.draft.trim().length === 0}>{thread.asking ? "Asking…" : "Ask Pi"}</button></div></div></div>;
}

function ReviewSummary({ pr, drafts, setDrafts, editingDraftId, setEditingDraftId, submitReview, submitting, refreshGithubActivity, refreshingActivity }: { pr: StoredPullRequest; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<void>; submitting: boolean; refreshGithubActivity: () => Promise<void>; refreshingActivity: boolean }) {
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  return <section className="panel"><h2>{pr.title}</h2><div className="meta"><span>{pr.key}</span><span>{pr.state}</span><span>{pr.filesChanged} files</span><span>{pr.existingCommentCount} comments</span><span>head {shortSha(pr.headSha)}</span></div><div className="link-row"><a href={pr.url} target="_blank" rel="noreferrer">Open GitHub</a><button onClick={() => void refreshGithubActivity()} disabled={refreshingActivity}>{refreshingActivity ? "Fetching…" : "Fetch GitHub activity"}</button></div><h2>Draft review</h2><select value={event} onChange={(change) => setEvent(change.target.value as typeof event)}><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><textarea value={body} onChange={(change) => setBody(change.target.value)} placeholder="Overall review body" />{drafts.length === 0 ? <p className="muted">No draft comments yet.</p> : drafts.map((draft) => <DraftView key={draft.id} draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} />)}<button disabled={submitting || (body.trim().length === 0 && drafts.length === 0)} onClick={() => void submitReview(event, body)}>{submitting ? "Submitting…" : `Submit review (${drafts.length})`}</button></section>;
}

function AiReviewPanel({ review, setReview, runReview, sendMessage, focusReview, runFocusReview, focusAreaCount }: { review: AiReview; setReview: (review: AiReview) => void; runReview: () => Promise<void>; sendMessage: (message: string) => Promise<void>; focusReview: FocusReview; runFocusReview: () => Promise<void>; focusAreaCount: number }) {
  const [draft, setDraft] = useState("");
  const hasMessages = review.messages.length > 0 || review.text.length > 0;
  const messages = review.messages.length > 0 ? review.messages : review.text.length > 0 ? [{ role: "pi" as const, text: review.text }] : [];
  const body = messages.length > 0 ? <div className="ai-chat-messages">{messages.map((message, index) => <div className={`ai-chat-message ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} /></div>)}</div> : <p className="muted">Run review or ask Pi about this PR.</p>;
  function submitChat() {
    if (draft.trim().length === 0 || review.running) return;
    const message = draft;
    setDraft("");
    void sendMessage(message);
  }
  const composer = <div className="ai-chat-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitChat(); } }} placeholder="Ask Pi about this PR…" /><Button variant="muted" onClick={submitChat} disabled={review.running || draft.trim().length === 0}>{review.running ? "Sending…" : "Send"}</Button></div>;
  return <>
    <section className="panel ai-review">
      <div className="thread-head"><h2>Pi review</h2><div className="actions"><Button className="focus-review-run" variant="muted" onClick={() => void runFocusReview()} disabled={focusReview.running}>{focusReview.running ? "Scanning…" : focusAreaCount > 0 ? `Focus scan (${focusAreaCount})` : "Focus scan"}</Button><Button variant="muted" onClick={() => setReview({ ...review, expanded: true, open: true })} disabled={!hasMessages && !review.open}>Focus</Button><Button variant="muted" onClick={() => setReview({ ...review, open: !review.open })}>{review.open ? "Collapse" : "Show"}</Button></div></div>
      <Button onClick={() => void runReview()} disabled={review.running}>{review.running ? "Reviewing…" : hasMessages ? "Run again" : "Run review"}</Button>
      {focusAreaCount > 0 && <p className="focus-review-note">{focusAreaCount} focus area{focusAreaCount === 1 ? "" : "s"} highlighted inline.</p>}
      {review.open && <>{body}{composer}</>}
    </section>
    <ModalShell open={review.expanded} onOpenChange={(open) => setReview({ ...review, expanded: open })} label="Pi review">
      <div className="thread-head"><h2>Pi review</h2><div className="actions"><Button variant="muted" onClick={() => void runReview()} disabled={review.running}>{review.running ? "Reviewing…" : hasMessages ? "Run again" : "Run review"}</Button><Button variant="muted" onClick={() => setReview({ ...review, expanded: false })}>Close</Button></div></div>
      <div className="review-modal-body ai-review-dialogue">{body}{composer}</div>
    </ModalShell>
  </>;
}

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

function DiagnosticsModal({ diagnostics, close }: { diagnostics: Record<string, unknown>; close: () => void }) {
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Pi diagnostics">
    <div className="thread-head"><h2>Pi diagnostics</h2><button onClick={close}>Close</button></div>
    <DiagnosticsView diagnostics={diagnostics} />
  </ModalShell>;
}

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
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Pi settings">
    <div className="thread-head"><h2>Pi settings</h2><button onClick={close}>Close</button></div>
    <label>Model<select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Select model…</option>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.provider}/{model.id}{model.name != null ? ` · ${model.name}` : ""}</option>)}</select></label>
    <label>Thinking<select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}><option value="">Keep current</option>{["off", "minimal", "low", "medium", "high", "xhigh"].map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
    <button onClick={() => void apply()} disabled={selected.length === 0}>Apply to this PR session</button>
    <DiagnosticsView diagnostics={diagnostics} />
  </ModalShell>;
}
function History({ prs, openPr, cleanupPr }: { prs: StoredPullRequest[]; openPr: (input: string) => Promise<void>; cleanupPr: (pr: StoredPullRequest) => Promise<void> }) { return <div className="history">{prs.length === 0 ? <p className="muted">No previous PRs.</p> : prs.map((pr) => <div className="history-row" key={pr.key}><button onClick={() => void openPr(pr.url)}><strong>{pr.title}</strong><span>{pr.key} · {pr.filesChanged ?? "—"} files · {pr.existingCommentCount ?? "—"} comments</span></button><button className="trash-button" title="Remove saved PR and cleanup worktree" onClick={() => void cleanupPr(pr)}>🗑</button></div>)}</div>; }
function LogRows({ logs }: { logs: LogEntry[] }) { return <>{logs.map((log) => <div className={`log ${log.level}`} key={log.id}><span>{new Date(log.timestamp).toLocaleTimeString()} {log.scope}</span><p>{log.message}</p>{log.data !== undefined && <code>{JSON.stringify(log.data)}</code>}</div>)}</>; }

createRoot(document.getElementById("root")!).render(<App />);
