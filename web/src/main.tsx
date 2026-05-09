import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "@primer/octicons-react";
import { api, askPi as askPiApi } from "./api";
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

type DiffViewMode = "unified" | "split";

type DiffProps = {
  review: OpenResponse;
  openFiles: Record<string, boolean>;
  setOpenFiles: (open: Record<string, boolean>) => void;
  diffViewMode: DiffViewMode;
  setDiffViewMode: (mode: DiffViewMode) => void;
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
  askFocusArea: (area: FocusArea, question: string, onDelta?: (answer: string) => void) => Promise<string>;
  sideWidth: number;
  setSideWidth: (width: number) => void;
  dragSelection: DragSelection | null;
  beginDrag: (target: Target) => void;
  updateDrag: (target: Target) => void;
  finishDrag: (target: Target) => void;
  handleRowClick: (target: Target, extend: boolean) => void;
  refreshGithubActivity: () => Promise<void>;
  commentCollapseSignal: number;
  commentsCollapsed: boolean;
  toggleAllComments: () => void;
  focusAreas: FocusArea[];
  activeFocusAreaId: string | null;
  setActiveFocusAreaId: (id: string | null) => void;
  collapsedFocusAreaIds: Record<string, boolean>;
  setCollapsedFocusAreaIds: (ids: Record<string, boolean> | ((ids: Record<string, boolean>) => Record<string, boolean>)) => void;
};

function focusReviewHasNoFindings(text: string): boolean {
  return text.trim().length > 0 && parseFocusAreas(text).length === 0;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function highlightFocusAreas(areas: FocusArea[], activeId: string | null, collapsedIds: Record<string, boolean>): void {
  document.querySelectorAll(".diff-row.focus-highlight, .diff-row.focus-highlight-active").forEach((row) => row.classList.remove("focus-highlight", "focus-highlight-active"));
  for (const area of areas.filter((candidate) => !collapsedIds[candidate.id])) {
    document.querySelectorAll<HTMLElement>(".diff-row[data-path][data-line]").forEach((row) => {
      const line = Number.parseInt(row.dataset.line ?? "", 10);
      if (row.dataset.path !== area.path || !Number.isFinite(line) || line < area.startLine || line > area.endLine) return;
      row.classList.add("focus-highlight");
      if (area.id === activeId) row.classList.add("focus-highlight-active");
    });
  }
  if (activeId != null && !collapsedIds[activeId]) document.querySelector(".diff-row.focus-highlight-active")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function App() {
  const [input, setInput] = useState("");
  const [prs, setPrs] = useState<StoredPullRequest[]>([]);
  const [review, setReview] = useState<OpenResponse | null>(null);
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified");
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
  const [collapsedFocusAreaIds, setCollapsedFocusAreaIds] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sideWidth, setSideWidth] = useState(380);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => localStorage.getItem("pi-review-theme") as ThemeName || "github-dark");
  const [commentCollapseSignal, setCommentCollapseSignal] = useState(0);
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  async function refreshHistory() { setPrs((await api<{ prs: StoredPullRequest[] }>("/api/prs")).prs); }
  async function refreshLogs() { setLogs((await api<{ logs: LogEntry[] }>("/api/logs")).logs.slice(-40).reverse()); }

  useEffect(() => { refreshHistory().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); refreshLogs().catch(() => undefined); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pi-review-theme", theme);
  }, [theme]);

  const focusAreas = useMemo(() => parseFocusAreas(focusReview.text), [focusReview.text]);
  useEffect(() => highlightFocusAreas(focusAreas, activeFocusAreaId, collapsedFocusAreaIds), [focusAreas, activeFocusAreaId, collapsedFocusAreaIds, openFiles, expandedNeighborRows]);
  useEffect(() => setCollapsedFocusAreaIds((current) => Object.fromEntries(Object.entries(current).filter(([id]) => focusAreas.some((area) => area.id === id)))), [focusAreas]);

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
      setCollapsedFocusAreaIds({});
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

  async function askFocusArea(area: FocusArea, question: string, onDelta?: (answer: string) => void): Promise<string> {
    if (review == null) return "Open a PR before asking Pi.";
    const prompt = `Review PR ${review.pr.key}. Focus area: ${area.path}:${area.startLine === area.endLine ? area.startLine : `${area.startLine}-${area.endLine}`}\n\nFocus finding:\n${area.body}\n\nQuestion: ${question}`;
    const answer = await askPiApi({ prKey: review.pr.key, prompt, purpose: "focus-chat" }, onDelta);
    await refreshLogs();
    return answer;
  }

  async function askThread(thread: Thread) {
    if (review == null || thread.draft.trim().length === 0) return;
    const question = thread.draft.trim();
    setThreads((current) => ({ ...current, [thread.key]: { ...thread, asking: true, draft: "", messages: [...thread.messages, { role: "user", text: question }, { role: "pi", text: "" }] } }));
    try {
      const prompt = `Review PR ${review.pr.key}. File: ${thread.target.path}. Lines: ${thread.target.line == null ? "file" : thread.target.startLine != null && thread.target.startLine !== thread.target.line ? `${thread.target.startLine}-${thread.target.line}` : thread.target.line}. Side: ${thread.target.side}. Hunk: ${thread.target.hunk}\n\nQuestion: ${question}`;
      const setAnswer = (answer: string) => setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], messages: [...(current[thread.key]?.messages ?? []).slice(0, -1), { role: "pi", text: answer }] } }));
      const answer = await askPiApi({ prKey: review.pr.key, prompt, purpose: "inline-chat" }, setAnswer);
      setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], asking: false, messages: [...(current[thread.key]?.messages ?? []).slice(0, -1), { role: "pi", text: answer }] } }));
      await refreshLogs();
    } catch (err) {
      const text = `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}`;
      setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], asking: false, messages: [...(current[thread.key]?.messages ?? []).slice(0, -1), { role: "pi", text }] } }));
    }
  }

  async function submitReview(event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) {
    if (review == null || submitting) return;
    setSubmitting(true);
    try {
      await api("/api/review/submit", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, headSha: review.pr.headSha, event, body, comments: drafts.filter((draft) => draft.line != null).map(({ path, line, startLine, side, body }) => ({ path, line, side, body, ...(startLine != null && startLine !== line ? { start_line: startLine, start_side: side } : {}) })) }) });
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
      const { job } = await api<{ job: { id: string } }>("/api/pi/review", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      for (;;) {
        await sleep(800);
        const { job: status } = await api<{ job: { status: "running" | "complete" | "failed"; answer?: string; error?: string } }>("/api/pi/review/status", { method: "POST", body: JSON.stringify({ jobId: job.id }) });
        if (status.status === "running") continue;
        if (status.status === "failed") throw new Error(status.error ?? "AI review failed");
        if (status.status !== "complete") throw new Error("AI review returned an unknown job status");
        const answer = status.answer ?? "AI review completed without output.";
        setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text: answer, messages: [...current.messages, { role: "pi", text: answer }] }));
        break;
      }
    } catch (err) {
      const text = `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text, messages: [...current.messages, { role: "pi", text }] }));
    }
  }

  async function sendAiReviewMessage(message: string) {
    if (review == null || aiReview.running || message.trim().length === 0) return;
    const question = message.trim();
    setAiReview((current) => ({ ...current, open: true, expanded: true, running: true, messages: [...current.messages, { role: "user", text: question }, { role: "pi", text: "" }] }));
    try {
      const previous = aiReview.messages.map((entry) => `${entry.role === "user" ? "User" : "Pi"}: ${entry.text}`).join("\n\n");
      const prompt = `Continue discussing PR ${review.pr.key}. Answer the user's latest question using the checked-out PR worktree. Be concise and cite files/lines when useful.\n\nPrevious dialogue:\n${previous || "(none)"}\n\nUser: ${question}`;
      const setAnswer = (answer: string) => setAiReview((current) => ({ ...current, open: true, expanded: true, text: answer, messages: [...current.messages.slice(0, -1), { role: "pi", text: answer }] }));
      const answer = await askPiApi({ prKey: review.pr.key, prompt, purpose: "chat" }, setAnswer);
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text: answer, messages: [...current.messages.slice(0, -1), { role: "pi", text: answer }] }));
    } catch (err) {
      const text = `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text, messages: [...current.messages.slice(0, -1), { role: "pi", text }] }));
    }
  }

  async function runFocusReview() {
    if (review == null || focusReview.running) return;
    setFocusReview((current) => ({ ...current, open: true, running: true }));
    const diffSummary = review.files.map((file) => `## ${file.filename}\nStatus: ${file.status}, +${file.additions}/-${file.deletions}\n${file.patch ?? "Patch unavailable"}`).join("\n\n");
    const prompt = `You are a second, independent PR-review pass for ${review.pr.key}. Look specifically for areas worth deeper human review, not a normal exhaustive review. Prioritize:\n- code that feels inconsistent with nearby codebase patterns or API conventions\n- surprising behavior, hidden assumptions, edge cases, or subtle tradeoffs\n- tests, migrations, performance, concurrency, or compatibility risks that deserve investigation\n- places where the implementation may be valid but reviewers should explicitly decide if the tradeoff is acceptable\n\nReturn markdown with a short "Focus areas" list. Start each item with a clickable-style location in this exact format: \`path:startLine-endLine — short title\` or \`path:line — short title\`. Then include why it is weird or worth investigation and a concrete reviewer question. Avoid generic praise and avoid blocking language unless there is strong evidence.\n\nPR title: ${review.pr.title}\n\n${diffSummary}`;
    try {
      const { job } = await api<{ job: { id: string } }>("/api/pi/focus-review", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, prompt }) });
      for (;;) {
        await sleep(800);
        const { job: status } = await api<{ job: { status: "running" | "complete" | "failed"; answer?: string; error?: string } }>("/api/pi/focus-review/status", { method: "POST", body: JSON.stringify({ jobId: job.id }) });
        if (status.status === "running") continue;
        if (status.status === "failed") throw new Error(status.error ?? "Focus review failed");
        if (status.status !== "complete") throw new Error("Focus review returned an unknown job status");
        const answer = status.answer ?? "Focus scan completed without output.";
        setFocusReview((current) => ({ ...current, open: true, running: false, text: answer }));
        setActiveFocusAreaId(parseFocusAreas(answer)[0]?.id ?? null);
        break;
      }
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

  function toggleAllComments(): void {
    setCommentsCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      setCollapsedFocusAreaIds(Object.fromEntries(focusAreas.map((area) => [area.id, nextCollapsed])));
      return nextCollapsed;
    });
    setCommentCollapseSignal((signal) => signal + 1);
  }

  return <main className="app-shell"><header className="toolbar"><div className="toolbar-title"><strong>Pi PR Review</strong><span>{review == null ? "Paste a PR to start" : `${review.pr.key} · ${review.pr.title}`}</span></div><div className="toolbar-actions">{review != null && <><button type="button" onClick={goHome}>Home</button><button type="button" title="Pi session settings" onClick={() => { setSettingsOpen(true); void loadDiagnostics(); }}>⚙</button><button type="button" title="Pi session diagnostics" onClick={() => void showDiagnostics()}>🐞</button></>}<button type="button" title="Server log" onClick={() => { setLogsOpen(true); void refreshLogs(); }}>📜</button><select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeName)}><option value="github-dark">GitHub dark</option><option value="github-dimmed">GitHub dimmed</option><option value="github-light">GitHub light</option></select>{review != null && <form className="open-form" onSubmit={submit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="OWNER/REPO#123 or GitHub PR URL" /><button disabled={busy || input.trim().length === 0}>{busy ? "Fetching…" : "Open"}</button></form>}</div></header>{error != null && <div className="error">{error}</div>}{busy && review == null ? <div className="loading-page"><svg className="loading-cog" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20a1 1 0 0 1-1-1v-1.07A7.002 7.002 0 0 1 5.07 12H4a1 1 0 1 1 0-2h1.07A7.002 7.002 0 0 1 11 4.07V3a1 1 0 1 1 2 0v1.07A7.002 7.002 0 0 1 18.93 10H20a1 1 0 1 1 0 2h-1.07A7.002 7.002 0 0 1 13 18.93V20a1 1 0 0 1-1 1Z" /><circle cx="12" cy="12" r="3" /></svg><p>Loading pull request…</p></div> : review == null ? <StartPage prs={prs} openPr={openPr} cleanupPr={cleanupPr} openInput={input} setOpenInput={setInput} busy={busy} /> : <ReviewPage review={review} openFiles={openFiles} setOpenFiles={setOpenFiles} diffViewMode={diffViewMode} setDiffViewMode={setDiffViewMode} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} threads={threads} setThreads={setThreads} toggleThread={toggleThread} setViewed={setViewed} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} sideWidth={sideWidth} setSideWidth={setSideWidth} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} commentCollapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} toggleAllComments={toggleAllComments} aiReview={aiReview} setAiReview={setAiReview} runAiReview={runAiReview} sendAiReviewMessage={sendAiReviewMessage} focusReview={focusReview} setFocusReview={setFocusReview} runFocusReview={runFocusReview} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} submitReview={submitReview} submitting={submitting} refreshGithubActivity={refreshGithubActivity} refreshingActivity={refreshingActivity} />}{diagnostics != null && !settingsOpen && <DiagnosticsModal diagnostics={diagnostics} aiReview={aiReview} focusReview={focusReview} focusAreaCount={focusAreas.length} refresh={loadDiagnostics} close={() => setDiagnostics(null)} />}{review != null && settingsOpen && <PiSettingsModal prKey={review.pr.key} diagnostics={diagnostics} setDiagnostics={setDiagnostics} close={() => setSettingsOpen(false)} />}{logsOpen && <LogsModal logs={logs} refreshLogs={refreshLogs} close={() => setLogsOpen(false)} />}</main>;
}

type StartFilter = "all" | "needs-review" | "in-progress" | "done";

function StartPage({ prs, openPr, cleanupPr, openInput, setOpenInput, busy }: { prs: StoredPullRequest[]; openPr: (input: string) => Promise<void>; cleanupPr: (pr: StoredPullRequest) => Promise<void>; openInput: string; setOpenInput: (value: string) => void; busy: boolean }) {
  const [filter, setFilter] = useState<StartFilter>("all");
  const groups = useMemo(() => groupPrsByStatus(prs), [prs]);
  const counts = { all: prs.length, "needs-review": groups.needsReview.length, "in-progress": groups.inProgress.length, done: groups.done.length } as const;
  const visibleGroups: Array<{ id: StartFilter; title: string; hint: string; prs: StoredPullRequest[] }> = [
    { id: "needs-review" as const, title: "Needs review", hint: "Not yet reviewed or new commits since your last pass.", prs: groups.needsReview },
    { id: "in-progress" as const, title: "In progress", hint: "You commented but did not approve or request changes.", prs: groups.inProgress },
    { id: "done" as const, title: "Done", hint: "Approved or changes requested at the current head.", prs: groups.done },
  ].filter((group) => filter === "all" || group.id === filter).filter((group) => group.prs.length > 0);
  return <div className="start-page">
    <section className="hero">
      <h1>Review a pull request</h1>
      <p className="muted">Paste a GitHub PR URL or <code>OWNER/REPO#123</code>. Pi will check it out and assist your review.</p>
      <form className="hero-form" onSubmit={(event) => { event.preventDefault(); void openPr(openInput); }}>
        <input autoFocus value={openInput} onChange={(event) => setOpenInput(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" />
        <button disabled={busy || openInput.trim().length === 0}>{busy ? "Fetching…" : "Open"}</button>
      </form>
    </section>
    {prs.length === 0 ? <section className="panel start-empty"><p className="muted">No previous reviews yet. Paste a PR above to get started.</p></section> : <>
      <nav className="start-filters" aria-label="Filter previous reviews">
        {(["all", "needs-review", "in-progress", "done"] as const).map((id) => <button key={id} type="button" className={`start-filter${filter === id ? " active" : ""}`} onClick={() => setFilter(id)}>{filterLabel(id)}<span className="start-filter-count">{counts[id]}</span></button>)}
      </nav>
      {visibleGroups.length === 0 ? <p className="muted">Nothing in this category.</p> : visibleGroups.map((group) => <section className="start-group" key={group.id}>
        <header className="start-group-head"><h2>{group.title}</h2><span className="muted">{group.hint}</span></header>
        <div className="pr-grid">{group.prs.map((pr) => <PrCard key={pr.key} pr={pr} openPr={openPr} cleanupPr={cleanupPr} />)}</div>
      </section>)}
    </>}
  </div>;
}

function filterLabel(id: StartFilter): string {
  if (id === "all") return "All";
  if (id === "needs-review") return "Needs review";
  if (id === "in-progress") return "In progress";
  return "Done";
}

function groupPrsByStatus(prs: StoredPullRequest[]): { needsReview: StoredPullRequest[]; inProgress: StoredPullRequest[]; done: StoredPullRequest[] } {
  const sorted = [...prs].sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""));
  const needsReview: StoredPullRequest[] = [];
  const inProgress: StoredPullRequest[] = [];
  const done: StoredPullRequest[] = [];
  for (const pr of sorted) {
    const status = reviewStatus(pr);
    if (status.tone === "success" || status.tone === "danger") done.push(pr);
    else if (pr.lastReviewEvent === "COMMENT" && pr.lastReviewedHeadSha === pr.headSha) inProgress.push(pr);
    else needsReview.push(pr);
  }
  return { needsReview, inProgress, done };
}

function PrCard({ pr, openPr, cleanupPr }: { pr: StoredPullRequest; openPr: (input: string) => Promise<void>; cleanupPr: (pr: StoredPullRequest) => Promise<void> }) {
  const status = reviewStatus(pr);
  return <article className={`pr-card status-${status.tone}`}>
    <button className="pr-card-body" onClick={() => void openPr(pr.url)}>
      <div className="pr-card-head">
        <strong className="pr-card-title">{pr.title}</strong>
        <span className={`review-status ${status.tone}`}>{status.label}</span>
      </div>
      <span className="pr-card-key">{pr.key}</span>
      <div className="pr-card-meta">
        <span>{pr.filesChanged ?? "—"} files</span>
        <span>{pr.existingCommentCount ?? 0} comments</span>
        <span>head {shortSha(pr.headSha)}</span>
        <span>{relativeTime(pr.lastOpenedAt)}</span>
      </div>
    </button>
    <button className="trash-button" title="Remove saved PR and cleanup worktree" onClick={() => void cleanupPr(pr)}>🗑</button>
  </article>;
}

function relativeTime(iso: string | null | undefined): string {
  if (iso == null) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function ReviewPage(props: DiffProps & { aiReview: AiReview; setAiReview: (review: AiReview) => void; runAiReview: () => Promise<void>; sendAiReviewMessage: (message: string) => Promise<void>; focusReview: FocusReview; setFocusReview: (review: FocusReview) => void; runFocusReview: () => Promise<void>; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<void>; submitting: boolean; refreshingActivity: boolean }) {
  const commentToggleLabel = props.commentsCollapsed ? "Expand all comments" : "Collapse all comments";
  const diffViewLabel = props.diffViewMode === "unified" ? "Split view" : "Unified view";
  const [sideTab, setSideTab] = useState<"review" | "pi" | "comments">("review");
  const draftCount = props.drafts.length;
  const piActivity = props.aiReview.messages.length + (props.aiReview.text.length > 0 && props.aiReview.messages.length === 0 ? 1 : 0);
  const focusCount = props.focusAreas.length;
  const piBadge = focusCount > 0 ? focusCount : piActivity > 0 ? piActivity : null;
  const commentCount = props.review.comments.length + props.review.issueComments.length;
  function jumpToComment(path: string, line: number | null): void {
    if (props.openFiles[path] === false) props.setOpenFiles({ ...props.openFiles, [path]: true });
    window.setTimeout(() => {
      const row = line != null
        ? document.querySelector(`.diff-row[data-path="${CSS.escape(path)}"][data-line="${line}"]`)
        : document.getElementById(`file-${path}`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }
  return <div className="review-layout" style={{ gridTemplateColumns: `minmax(0, 1fr) 12px ${props.sideWidth}px` }}>
    <main className="files">
      <PrHeaderStrip pr={props.review.pr} refreshGithubActivity={props.refreshGithubActivity} refreshingActivity={props.refreshingActivity} />
      <FileNavigator files={props.review.files} fileReviews={props.review.fileReviews} openFiles={props.openFiles} setOpenFiles={props.setOpenFiles} />
      <div className="comment-tools">
        <button className="small-muted-button" onClick={() => props.setDiffViewMode(props.diffViewMode === "unified" ? "split" : "unified")}>{diffViewLabel}</button>
        <button className="small-muted-button" onClick={props.toggleAllComments}>{commentToggleLabel}</button>
      </div>
      {props.review.files.map((file) => <FileDiff key={file.filename} file={file} {...props} />)}
    </main>
    <div className="resize-handle" role="separator" aria-label="Resize side panel" onMouseDown={(event) => startResizeSidePanel(event, props.sideWidth, props.setSideWidth)} />
    <aside className="side">
      <nav className="side-tabs" role="tablist" aria-label="Review side panel">
        <button role="tab" aria-selected={sideTab === "review"} className={`side-tab${sideTab === "review" ? " active" : ""}`} onClick={() => setSideTab("review")}>Review{draftCount > 0 && <span className="side-tab-badge">{draftCount}</span>}</button>
        <button role="tab" aria-selected={sideTab === "pi"} className={`side-tab${sideTab === "pi" ? " active" : ""}`} onClick={() => setSideTab("pi")}>Pi{piBadge != null && <span className="side-tab-badge">{piBadge}</span>}</button>
        <button role="tab" aria-selected={sideTab === "comments"} className={`side-tab${sideTab === "comments" ? " active" : ""}`} onClick={() => setSideTab("comments")}>Comments{commentCount > 0 && <span className="side-tab-badge">{commentCount}</span>}</button>
      </nav>
      <div className="side-tab-panels">
        {sideTab === "review" && <ReviewSummary pr={props.review.pr} drafts={props.drafts} setDrafts={props.setDrafts} editingDraftId={props.editingDraftId} setEditingDraftId={props.setEditingDraftId} submitReview={props.submitReview} submitting={props.submitting} onJumpToDraft={(draft) => jumpToComment(draft.path, draft.line)} />}
        {sideTab === "pi" && <AiReviewPanel prUrl={props.review.pr.url} review={props.aiReview} setReview={props.setAiReview} runReview={props.runAiReview} sendMessage={props.sendAiReviewMessage} focusReview={props.focusReview} runFocusReview={props.runFocusReview} focusAreas={props.focusAreas} setActiveFocusAreaId={props.setActiveFocusAreaId} collapsedFocusAreaIds={props.collapsedFocusAreaIds} setCollapsedFocusAreaIds={props.setCollapsedFocusAreaIds} openFiles={props.openFiles} setOpenFiles={props.setOpenFiles} />}
        {sideTab === "comments" && <ExistingComments prUrl={props.review.pr.url} comments={props.review.comments} issueComments={props.review.issueComments} refreshGithubActivity={props.refreshGithubActivity} collapseSignal={props.commentCollapseSignal} commentsCollapsed={props.commentsCollapsed} toggleAllComments={props.toggleAllComments} onJumpToComment={jumpToComment} />}
      </div>
    </aside>
    {draftCount > 0 && sideTab !== "review" && <Button className="floating-submit" onClick={() => setSideTab("review")}>Review draft ({draftCount}) →</Button>}
  </div>;
}

function PrHeaderStrip({ pr, refreshGithubActivity, refreshingActivity }: { pr: StoredPullRequest; refreshGithubActivity: () => Promise<void>; refreshingActivity: boolean }) {
  const status = reviewStatus(pr);
  return <section className="pr-header-strip">
    <div className="pr-header-main">
      <h1 className="pr-header-title">{pr.title}</h1>
      <div className="pr-header-meta">
        <span className={`review-status ${status.tone}`}>{status.label}</span>
        <span>{pr.key}</span>
        <span>{pr.state}</span>
        <span>{pr.filesChanged} files</span>
        <span>{pr.existingCommentCount} comments</span>
        <span>head {shortSha(pr.headSha)}</span>
      </div>
    </div>
    <div className="pr-header-actions">
      <a href={pr.url} target="_blank" rel="noreferrer">Open GitHub ↗</a>
      <button onClick={() => void refreshGithubActivity()} disabled={refreshingActivity}>{refreshingActivity ? "Fetching…" : "Fetch activity"}</button>
    </div>
  </section>;
}

function FileNavigator({ files, fileReviews, openFiles, setOpenFiles }: { files: PullFile[]; fileReviews: FileReviewState[]; openFiles: Record<string, boolean>; setOpenFiles: (open: Record<string, boolean>) => void }) {
  const [open, setOpen] = useState(false);
  const viewedCount = files.filter((file) => fileReviews.find((state) => state.path === file.filename)?.viewed).length;
  function jumpTo(filename: string) {
    if (openFiles[filename] === false) setOpenFiles({ ...openFiles, [filename]: true });
    window.setTimeout(() => document.getElementById(`file-${filename}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }
  return <details className="file-navigator" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
    <summary><span><strong>Files</strong> · {viewedCount}/{files.length} viewed</span>{open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}</summary>
    <ol className="file-navigator-list">
      {files.map((file) => {
        const viewed = fileReviews.find((state) => state.path === file.filename)?.viewed ?? false;
        return <li key={file.filename} className={viewed ? "viewed" : ""}>
          <button onClick={() => jumpTo(file.filename)}>
            <span className="file-nav-check" aria-hidden="true">{viewed ? "✓" : "•"}</span>
            <span className="file-nav-path">{file.filename}</span>
            <span className="file-nav-stats"><span className="stat-add">+{file.additions}</span> <span className="stat-del">-{file.deletions}</span></span>
          </button>
        </li>;
      })}
    </ol>
  </details>;
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

function FileDiff({ file, review, openFiles, setOpenFiles, expandedContext, setExpandedContext, expandedNeighborRows, expandNeighbor, threads, setThreads, toggleThread, setViewed, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, refreshGithubActivity, commentCollapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: DiffProps & { file: PullFile }) {
  const rows = useMemo(() => parsePatchRows(file.patch), [file.patch]);
  const fileReview = review.fileReviews.find((state) => state.path === file.filename);
  const open = openFiles[file.filename] ?? true;
  return <section className="file" id={`file-${file.filename}`}><div className="file-summary"><button className="file-summary-left" onClick={() => setOpenFiles({ ...openFiles, [file.filename]: !open })}><span className="collapse-chevron">{open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}</span><strong>{file.filename}</strong><span>{file.status} · <span className="stat-add">+{file.additions}</span> / <span className="stat-del">-{file.deletions}</span></span></button><label className="viewed-toggle" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={fileReview?.viewed ?? false} onChange={(event) => void setViewed(file, event.target.checked)} /> Viewed</label></div>{open && <><div className="patch">{rows.length === 0 ? <DiffRowView row={{ kind: "meta", oldLine: null, newLine: null, text: "Patch unavailable. Click to attach a file-level note.", hunk: "" }} target={{ path: file.filename, line: null, side: "RIGHT", hunk: "" }} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={review.comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} /> : <FoldedRows file={file} rows={rows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />}</div></>}</section>;
}

function FoldedRows({ file, rows, comments, threads, setThreads, toggleThread, expandedNeighborRows, expandNeighbor, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { file: PullFile; rows: DiffRow[]; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; expandedContext: Record<string, boolean>; setExpandedContext: (expanded: Record<string, boolean>) => void; expandedNeighborRows: Record<string, DiffRow[]>; expandNeighbor: (file: PullFile, key: string, startLine: number, endLine: number) => Promise<void>; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== "hunk") {
      rendered.push(<ConnectedRow key={`${file.filename}:${index}`} file={file} row={rows[index]} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />);
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
      (expandedNeighborRows[aboveKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${aboveKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />));
    }

    block.forEach((row, offset) => rendered.push(<ConnectedRow key={`${file.filename}:${index + offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />));

    if (lastLine != null) {
      const belowKey = `${file.filename}:${index}:below`;
      (expandedNeighborRows[belowKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${belowKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />));
      rendered.push(<button className="fold neighbor" key={`${belowKey}:button`} onClick={() => void expandNeighbor(file, belowKey, lastLine + 1, lastLine + (expandedNeighborRows[belowKey]?.length ?? 0) + 10)}>Expand below</button>);
    }
    index = blockEnd - 1;
  }
  return <>{rendered}</>;
}

function ConnectedRow({ file, row, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { file: PullFile; row: DiffRow; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  const line = row.newLine ?? row.oldLine;
  const target = line == null || row.kind === "hunk" || row.kind === "meta" ? null : { path: file.filename, line, side: row.newLine != null ? "RIGHT" as const : "LEFT" as const, hunk: row.hunk };
  return <DiffRowView row={row} target={target} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />;
}

function updateDraft(drafts: DraftComment[], setDrafts: (drafts: DraftComment[]) => void, id: string, body: string): void {
  setDrafts(drafts.map((draft) => draft.id === id ? { ...draft, body } : draft));
}

function DraftView({ draft, drafts, setDrafts, editingDraftId, setEditingDraftId, onJump }: { draft: DraftComment; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; onJump?: () => void }) {
  const editing = editingDraftId === draft.id;
  const [removing, setRemoving] = useState(false);
  function removeDraft(): void {
    if (removing) return;
    setRemoving(true);
    window.setTimeout(() => setDrafts(drafts.filter((item) => item.id !== draft.id)), 160);
  }
  return <div className={`draft-card${editing ? " editing" : ""}${removing ? " removing" : ""}`}>
    <div className="draft-card-head">
      <div className={`draft-card-location${onJump != null ? " clickable" : ""}`} onClick={onJump} role={onJump != null ? "button" : undefined} tabIndex={onJump != null ? 0 : undefined}>
        <strong>{targetLabel(draft)}</strong>
      </div>
      <div className="draft-card-actions">
        <Button variant="icon" aria-label={editing ? "Done editing" : "Edit draft"} onClick={() => setEditingDraftId(editing ? null : draft.id)}>{editing ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}</Button>
        <Button variant="icon" className="close-thread-button" aria-label="Remove draft" onClick={removeDraft} disabled={removing}><XIcon size={14} /></Button>
      </div>
    </div>
    <div className="draft-card-body">{editing ? <textarea autoFocus value={draft.body} onChange={(event) => updateDraft(drafts, setDrafts, draft.id, event.target.value)} /> : <p>{draft.body}</p>}</div>
  </div>;
}

function DiffRowView({ row, target, threads, setThreads, toggleThread, comments, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { row: DiffRow; target: Target | null; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; comments: PullReviewComment[]; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  const thread = target == null ? null : threadForTarget(threads, target);
  const inlineComments = target == null ? [] : comments.filter((comment) => comment.path === target.path && targetKey(commentTarget(comment)) === targetKey(target));
  const inlineCommentThreads = groupReviewComments(inlineComments);
  const inlineDrafts = target == null ? [] : drafts.filter((draft) => draftMatchesTarget(draft, target));
  const selecting = isTargetInSelection(target, dragSelection);
  const inThreadRange = target != null && target.line != null && Object.values(threads).some((t) => !t.collapsed && t.target.path === target.path && t.target.startLine != null && t.target.line != null && target.line! >= t.target.startLine && target.line! <= t.target.line);
  const rowFocusAreas = target == null ? [] : focusAreas.filter((area) => area.path === target.path && target.line === area.endLine);
  const language = languageForPath(target?.path);
  const hasThreadPill = thread != null || inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length > 0;
  const threadPill = hasThreadPill ? <span className="pill">{(thread == null ? 0 : 1) + inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length}</span> : null;
  const unifiedCells = <><span className="num">{row.oldLine ?? ""}</span><span className="num">{row.newLine ?? ""}</span><CodeText code={row.text} language={language} />{threadPill}</>;
  const splitCells = <><span className="num">{row.oldLine ?? ""}</span><div className="split-code old-code">{row.newLine == null || row.kind === "context" || row.kind === "hunk" || row.kind === "meta" ? <CodeText code={row.text} language={language} /> : null}</div><span className="num">{row.newLine ?? ""}</span><div className="split-code new-code">{row.oldLine == null || row.kind === "context" || row.kind === "hunk" || row.kind === "meta" ? <CodeText code={row.text} language={language} /> : null}</div>{threadPill}</>;
  return <><div className={`diff-row ${diffViewMode} ${row.kind} ${thread != null && !thread.collapsed ? "selected" : ""} ${selecting ? "range-selecting" : ""} ${inThreadRange ? "in-thread-range" : ""}`} data-path={target?.path} data-line={target?.line ?? undefined} data-side={target?.side} data-hunk={target?.hunk} onMouseDown={(event) => { if (target != null && event.button === 0) { event.preventDefault(); beginDrag(target); } }} onMouseEnter={() => { if (target != null && dragSelection != null) updateDrag(target); }} onMouseUp={() => { if (target != null) finishDrag(target); }} onClick={(event) => { if (target != null) handleRowClick(target, event.shiftKey); }}>{diffViewMode === "split" ? splitCells : unifiedCells}</div>{inlineCommentThreads.map((commentThread) => <ExistingReviewThread key={commentThread.map((comment) => comment.id).join(":")} comments={commentThread} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} />)}{rowFocusAreas.map((area) => <FocusAreaInline key={area.id} prUrl={prUrl} area={area} active={area.id === activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} askFocusArea={askFocusArea} addDraft={(body) => setDrafts([...drafts, { id: newId(), path: area.path, line: area.endLine, startLine: area.startLine, side: "RIGHT", body }])} />)}{inlineDrafts.map((draft) => <div className="inline-thread draft" key={draft.id}><DraftView draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} /></div>)}{thread != null && <ThreadBox prUrl={prUrl} thread={thread} setThread={(next) => setThreads((current) => ({ ...current, [next.key]: next }))} closeThread={() => setThreads((current) => { const next = { ...current }; delete next[thread.key]; return next; })} addDraft={() => { if (thread.draft.trim().length > 0) setDrafts([...drafts, { id: newId(), path: thread.target.path, line: thread.target.line, startLine: thread.target.startLine, side: thread.target.side, body: thread.draft.trim() }]); setThreads((current) => { const next = { ...current }; if (thread.messages.length === 0) delete next[thread.key]; else next[thread.key] = { ...thread, draft: "", collapsed: true }; return next; }); }} askThread={askThread} />}</>;
}

function FocusAreaInline({ prUrl, area, active, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds, askFocusArea, addDraft }: { prUrl: string; area: FocusArea; active: boolean; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"]; askFocusArea: DiffProps["askFocusArea"]; addDraft: (body: string) => void }) {
  const collapsed = collapsedFocusAreaIds[area.id] ?? false;
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: "user" | "pi"; text: string }>>([]);
  void active; void setActiveFocusAreaId;
  function saveDraftComment() {
    const body = draft.trim();
    if (body.length === 0) return;
    addDraft(body);
    setDraft("");
  }
  async function ask() {
    const question = draft.trim();
    if (question.length === 0 || asking) return;
    setDraft("");
    setAsking(true);
    setMessages((current) => [...current, { role: "user", text: question }, { role: "pi", text: "" }]);
    try {
      const setAnswer = (answer: string) => setMessages((current) => [...current.slice(0, -1), { role: "pi", text: answer }]);
      const answer = await askFocusArea(area, question, setAnswer);
      setMessages((current) => [...current.slice(0, -1), { role: "pi", text: answer }]);
    } catch (err) {
      setMessages((current) => [...current.slice(0, -1), { role: "pi", text: `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setAsking(false);
    }
  }
  if (collapsed) return <button id={`focus-area-${area.id}`} className="inline-thread collapsed focus-area-collapsed" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: false }))}><ChevronRightIcon size={14} /> Focus area · {area.title}</button>;
  return <div id={`focus-area-${area.id}`} className="inline-thread review-thread focus-area-inline"><div className="thread-head"><div><strong>Focus area</strong><span>{area.path}:{area.startLine === area.endLine ? area.startLine : `${area.startLine}-${area.endLine}`}</span></div><div className="actions"><Button variant="icon" aria-label="Collapse focus area" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: true }))}><ChevronDownIcon size={16} /></Button></div></div><div className="thread-messages"><div className="thread-note pi"><div className="message-role">Pi focus</div><MarkdownText text={area.body} fileLinks={{ prUrl }} /></div>{messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div>)}</div><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void ask(); } }} placeholder="Ask Pi or write a draft comment about this focus area" /><div className="actions"><button onClick={saveDraftComment} disabled={draft.trim().length === 0}>Add draft comment</button><button onClick={() => void ask()} disabled={asking || draft.trim().length === 0}>{asking ? <span className="spinner-label"><span className="spinner" aria-hidden="true" />Asking</span> : "Ask Pi"}</button></div></div></div>;
}

function ThreadBox({ prUrl, thread, setThread, closeThread, addDraft, askThread }: { prUrl: string; thread: Thread; setThread: (thread: Thread) => void; closeThread: () => void; addDraft: () => void; askThread: (thread: Thread) => Promise<void> }) {
  if (thread.collapsed) return <button className="inline-thread collapsed" onClick={() => setThread({ ...thread, collapsed: false })}><ChevronRightIcon size={14} /> Thread on {thread.target.line == null ? "file" : targetLabel(thread.target)}</button>;
  return <div className="inline-thread review-thread"><div className="thread-head"><div><strong>Line thread</strong><span>{targetLabel(thread.target)}</span></div><div className="actions">{(thread.draft.trim().length > 0 || thread.messages.length > 0) && <Button variant="icon" aria-label="Collapse thread" onClick={() => setThread({ ...thread, collapsed: true })}><ChevronDownIcon size={16} /></Button>}<Button variant="icon" className="close-thread-button" aria-label="Close thread" onClick={closeThread}><XIcon size={16} /></Button></div></div>{thread.target.line != null && <label className="range-control">Range end <input type="number" value={thread.target.line} min={thread.target.startLine ?? thread.target.line} onChange={(event) => setThread({ ...thread, target: { ...thread.target, startLine: thread.target.startLine ?? thread.target.line, line: Number.parseInt(event.target.value, 10) || thread.target.line } })} /></label>}{thread.messages.length > 0 && <div className="thread-messages">{thread.messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div>)}</div>}<div className="composer"><textarea value={thread.draft} onChange={(event) => setThread({ ...thread, draft: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && thread.draft.trim().length > 0 && !thread.asking) { event.preventDefault(); void askThread(thread); } }} placeholder="Write a draft comment or ask Pi about this line" /><div className="actions"><button onClick={addDraft} disabled={thread.draft.trim().length === 0}>Add draft comment</button><button onClick={() => void askThread(thread)} disabled={thread.asking || thread.draft.trim().length === 0}>{thread.asking ? <span className="spinner-label"><span className="spinner" aria-hidden="true" />Asking</span> : "Ask Pi"}</button></div></div></div>;
}

function reviewStatus(pr: StoredPullRequest): { label: string; tone: string } {
  if (pr.reviewDecision === "APPROVED") return { label: "Approved", tone: "success" };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "danger" };
  if (pr.lastReviewedHeadSha == null) return { label: "Not reviewed", tone: "pending" };
  if (pr.lastReviewedHeadSha !== pr.headSha) return { label: "Needs review", tone: "pending" };
  if (pr.lastReviewEvent === "APPROVE") return { label: "Approved", tone: "success" };
  if (pr.lastReviewEvent === "REQUEST_CHANGES") return { label: "Changes requested", tone: "danger" };
  return { label: "Reviewed", tone: "success" };
}

function ReviewSummary({ drafts, setDrafts, editingDraftId, setEditingDraftId, submitReview, submitting, onJumpToDraft }: { pr: StoredPullRequest; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<void>; submitting: boolean; onJumpToDraft?: (draft: DraftComment) => void }) {
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  return <section className="panel"><h2>Draft review</h2><select className={`review-event ${event.toLowerCase().replace("_", "-")}`} value={event} onChange={(change) => setEvent(change.target.value as typeof event)}><option value="COMMENT">Not reviewed</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><textarea value={body} onChange={(change) => setBody(change.target.value)} placeholder="Overall review body" />{drafts.length === 0 ? <p className="muted">No draft comments yet.</p> : drafts.map((draft) => <DraftView key={draft.id} draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} onJump={onJumpToDraft != null ? () => onJumpToDraft(draft) : undefined} />)}<button className={`review-submit ${event.toLowerCase().replace("_", "-")}`} disabled={submitting || (body.trim().length === 0 && drafts.length === 0)} onClick={() => void submitReview(event, body)}>{submitting ? "Submitting…" : `Submit review (${drafts.length})`}</button></section>;
}

function AiReviewPanel({ prUrl, review, setReview, runReview, sendMessage, focusReview, runFocusReview, focusAreas, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds, openFiles, setOpenFiles }: { prUrl: string; review: AiReview; setReview: (review: AiReview) => void; runReview: () => Promise<void>; sendMessage: (message: string) => Promise<void>; focusReview: FocusReview; runFocusReview: () => Promise<void>; focusAreas: FocusArea[]; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"]; openFiles: Record<string, boolean>; setOpenFiles: (open: Record<string, boolean>) => void }) {
  const [draft, setDraft] = useState("");
  const [viewedFocusIds, setViewedFocusIds] = useState<Record<string, boolean>>({});
  const focusAreaCount = focusAreas.length;
  const allFocusCollapsed = focusAreaCount > 0 && focusAreas.every((area) => collapsedFocusAreaIds[area.id]);
  const hasMessages = review.messages.length > 0 || review.text.length > 0;
  const messages = review.messages.length > 0 ? review.messages : review.text.length > 0 ? [{ role: "pi" as const, text: review.text }] : [];
  const body = messages.length > 0 ? <div className="ai-chat-messages">{messages.map((message, index) => <div className={`ai-chat-message ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div>)}</div> : <p className="muted">Run review or ask Pi about this PR.</p>;
  function submitChat() {
    if (draft.trim().length === 0 || review.running) return;
    const message = draft;
    setDraft("");
    void sendMessage(message);
  }
  function toggleFocusAreas(): void {
    setCollapsedFocusAreaIds(Object.fromEntries(focusAreas.map((area) => [area.id, !allFocusCollapsed])));
  }
  function jumpToFocusArea(area: FocusArea): void {
    setActiveFocusAreaId(area.id);
    setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: false }));
    if (openFiles[area.path] === false) setOpenFiles({ ...openFiles, [area.path]: true });
    window.setTimeout(() => document.getElementById(`focus-area-${area.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }
  function toggleFocusViewed(area: FocusArea): void {
    const next = !viewedFocusIds[area.id];
    setViewedFocusIds((current) => ({ ...current, [area.id]: next }));
    if (next) setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: true }));
  }
  const composer = <div className="ai-chat-composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitChat(); } }} placeholder="Ask Pi about this PR…" /><Button variant="muted" onClick={submitChat} disabled={review.running || draft.trim().length === 0}>{review.running ? "Sending…" : "Send"}</Button></div>;
  const viewedCount = focusAreas.filter((area) => viewedFocusIds[area.id]).length;
  const focusAreaLinks = focusAreaCount > 0 && <div className="focus-area-links" aria-label="Focus areas">
    <div className="focus-area-links-head">
      <strong>{viewedCount}/{focusAreaCount} focus area{focusAreaCount === 1 ? "" : "s"} reviewed</strong>
      <Button variant="muted" className="small-muted-button" onClick={toggleFocusAreas}>{allFocusCollapsed ? "Expand all" : "Collapse all"}</Button>
    </div>
    {focusAreas.map((area, index) => {
      const viewed = viewedFocusIds[area.id] ?? false;
      return <div key={area.id} className={`focus-area-link-row${viewed ? " viewed" : ""}`}>
        <label className="focus-area-check" title="Mark as reviewed" onClick={(event) => event.stopPropagation()}>
          <input type="checkbox" checked={viewed} onChange={() => toggleFocusViewed(area)} />
        </label>
        <button type="button" onClick={() => jumpToFocusArea(area)}>
          <strong>{index + 1}. {area.title}</strong>
          <span>{area.path}:{area.startLine === area.endLine ? area.startLine : `${area.startLine}-${area.endLine}`}</span>
        </button>
      </div>;
    })}
  </div>;
  void setReview;
  return <section className="panel ai-review">
    <h2>Pi</h2>
    <div className="pi-actions">
      <div className="pi-action">
        <Button className="focus-review-run" onClick={() => void runFocusReview()} disabled={focusReview.running}>{focusReview.running ? "Scanning…" : "Focus scan"}</Button>
        <span className="muted">Find specific lines worth deeper review. Results appear inline in the diff.</span>
      </div>
      <div className="pi-action">
        <Button onClick={() => void runReview()} disabled={review.running}>{review.running ? "Reviewing…" : hasMessages ? "Run again" : "Full review"}</Button>
        <span className="muted">Run a general code review. Output appears in the chat below.</span>
      </div>
    </div>
    {focusReview.text.length > 0 && focusAreaCount === 0 && <p className="focus-review-note clean">Focus scan clean: nothing specific to dig into.</p>}
    {focusAreaLinks}
    {body}{composer}
  </section>;
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
  const sessions = diagnosticsArray(diagnostics.sessions) as Array<{ purpose?: string; ready?: boolean; queued?: boolean; isStreaming?: boolean | null; activeTools?: unknown[]; lastPrompt?: { chars?: number; preview?: string; startedAt?: string } | null; promptState?: { status?: string; elapsedMs?: number; chars?: number; answerChars?: number; error?: string } | null }>;
  return <div className="diagnostics-view"><div className="diagnostics-grid"><div><span>Model</span><strong>{diagnosticsText(diagnostics.model)}</strong></div><div><span>Thinking</span><strong>{diagnosticsText(diagnostics.thinkingLevel)}</strong></div><div><span>Active tools</span><strong>{activeTools.length}</strong></div><div><span>Available models</span><strong>{models.length}</strong></div></div><section><h3>Pi session health</h3>{sessions.length === 0 ? <p className="muted">No Pi sessions for this PR yet.</p> : <div className="model-list">{sessions.map((session) => <div className="log" key={session.purpose}><span>{session.purpose} · {session.ready ? "ready" : "creating"}{session.queued ? " · queued" : ""}{session.isStreaming ? " · streaming" : ""}</span><p>{session.promptState == null ? "No prompt state" : `${session.promptState.status ?? "unknown"} · ${Math.round((session.promptState.elapsedMs ?? 0) / 1000)}s · ${session.promptState.chars ?? 0} prompt chars · ${session.promptState.answerChars ?? 0} answer chars`}</p>{session.promptState?.error != null && <code>{session.promptState.error}</code>}{session.lastPrompt?.preview != null && <pre className="prompt-preview">{session.lastPrompt.preview}</pre>}</div>)}</div>}</section><section><h3>Session</h3><dl><dt>PR key</dt><dd>{diagnosticsText(diagnostics.prKey)}</dd><dt>CWD</dt><dd>{diagnosticsText(diagnostics.cwd)}</dd><dt>Session file</dt><dd>{diagnosticsText(diagnostics.sessionFile)}</dd><dt>Session ID</dt><dd>{diagnosticsText(diagnostics.sessionId)}</dd></dl></section><section><h3>Last chat prompt</h3>{lastPrompt == null ? <p className="muted">No prompt sent yet.</p> : <><p className="muted">{lastPrompt.chars ?? 0} chars · {lastPrompt.startedAt ?? "unknown time"}</p><pre className="prompt-preview">{lastPrompt.preview}</pre></>}</section><details open><summary>Active tools ({activeTools.length})</summary><div className="chip-list">{activeTools.map((tool, index) => <span className="chip" key={index}>{diagnosticsText(tool)}</span>)}</div></details><details><summary>Available models ({models.length})</summary><div className="model-list">{models.map((model, index) => <code key={index}>{diagnosticsText(model)}</code>)}</div></details><details><summary>All tool definitions ({tools.length})</summary><div className="model-list">{tools.map((tool, index) => <code key={index}>{diagnosticsText(tool)}</code>)}</div></details><details><summary>Raw diagnostics</summary><pre className="diagnostics-json">{JSON.stringify(diagnostics, null, 2)}</pre></details></div>;
}

function PiRunDiagnostics({ aiReview, focusReview, focusAreaCount }: { aiReview: AiReview; focusReview: FocusReview; focusAreaCount: number }) {
  return <section><h3>Pi runs</h3><div className="diagnostics-grid"><div><span>Review chat</span><strong>{aiReview.running ? "running" : aiReview.messages.length > 0 ? `${aiReview.messages.length} messages` : "idle"}</strong></div><div><span>Focus scan</span><strong>{focusReview.running ? "running" : focusReview.text.length === 0 ? "not run" : focusAreaCount > 0 ? `${focusAreaCount} findings` : "clean"}</strong></div></div>{focusReview.text.length > 0 && <details open><summary>Focus scan output</summary><pre className="prompt-preview">{focusReview.text}</pre></details>}{aiReview.text.length > 0 && <details><summary>Latest Pi review/chat answer</summary><pre className="prompt-preview">{aiReview.text}</pre></details>}</section>;
}

function DiagnosticsModal({ diagnostics, aiReview, focusReview, focusAreaCount, refresh, close }: { diagnostics: Record<string, unknown>; aiReview: AiReview; focusReview: FocusReview; focusAreaCount: number; refresh: () => Promise<Record<string, unknown> | null>; close: () => void }) {
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Pi diagnostics">
    <div className="thread-head"><h2>Pi diagnostics</h2><div className="actions"><button onClick={() => void refresh()}>Refresh</button><button onClick={close}>Close</button></div></div>
    <PiRunDiagnostics aiReview={aiReview} focusReview={focusReview} focusAreaCount={focusAreaCount} />
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
function LogsModal({ logs, refreshLogs, close }: { logs: LogEntry[]; refreshLogs: () => Promise<void>; close: () => void }) {
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Server log">
    <div className="thread-head"><h2>Server log</h2><div className="actions"><button onClick={() => void refreshLogs()}>Refresh</button><button onClick={close}>Close</button></div></div>
    <div className="logs-modal-body">{logs.length === 0 ? <p className="muted">No log entries yet.</p> : <LogRows logs={logs} />}</div>
  </ModalShell>;
}

function LogRows({ logs }: { logs: LogEntry[] }) { return <>{logs.map((log) => <div className={`log ${log.level}`} key={log.id}><span>{new Date(log.timestamp).toLocaleTimeString()} {log.scope}</span><p>{log.message}</p>{log.data !== undefined && <code>{JSON.stringify(log.data)}</code>}</div>)}</>; }

createRoot(document.getElementById("root")!).render(<App />);
