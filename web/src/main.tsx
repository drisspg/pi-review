import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "@primer/octicons-react";
import { api, askPi as askPiApi } from "./api";
import { Button } from "./components/Button";
import { CodeText, MarkdownText } from "./components/Markdown";
import { ModalShell } from "./components/Modal";
import { ExistingComments, ExistingReviewThread } from "./components/Threads";
import { commentTarget, commentThreadDomId, draftMatchesTarget, groupReviewComments, targetKey, targetLabel, threadForTarget } from "./lib/comments";
import { contextRowsFromText, hunkNewStart, isTargetInSelection, lastNewLine, parsePatchRows, targetFromPoint, targetFromRow } from "./lib/diff";
import { languageForPath } from "./lib/highlight";
import { newId, prUrlFromKey, shortSha } from "./lib/pr";
import type { AiReview, AiReviewMessage, AiReviewRecord, DiffRow, DraftComment, DragSelection, FileReviewState, FocusArea, FocusAreaReviewState, FocusReview, FocusScanRecord, LogEntry, OpenResponse, PullFile, PullIssueComment, PullReviewComment, StoredPullRequest, Target, ThemeName, Thread } from "./types";
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

function generalReviewMessage(text: string): AiReviewMessage {
  return { role: "pi", kind: "general-review", title: "General review", text };
}

function mergeGeneralReview(messages: AiReviewMessage[], text: string): AiReviewMessage[] {
  const index = messages.findIndex((message) => message.kind === "general-review");
  if (index === -1) return [generalReviewMessage(text), ...messages];
  return messages.map((message, messageIndex) => messageIndex === index ? generalReviewMessage(text) : message);
}

function currentGeneralReviewText(review: AiReview): string {
  return review.messages.find((message) => message.kind === "general-review")?.text.trim() ?? (review.messages.length === 0 ? review.text.trim() : "");
}

function focusAreaPath(path: string): string {
  return path.trim().replace(/^[-*]\s+/, "").trim();
}

function parseFocusAreas(text: string): FocusArea[] {
  const location = /(?:^|[`\s(*-])([\w./@+-][\w./@+ -]*?\.[\w+-]+):(\d+)(?:-(\d+))?(?:\s*[—-]\s*([^\n]+))?/gm;
  const areas: FocusArea[] = [];
  for (const match of text.matchAll(location)) {
    const path = focusAreaPath(match[1]);
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

function focusAreaKey(area: FocusArea): string {
  return `${area.path}:${area.startLine}-${area.endLine}`;
}

function focusAreaFromKey(key: string): Pick<FocusArea, "path" | "startLine" | "endLine"> | null {
  const match = /^(.*):(\d+)-(\d+)$/.exec(key);
  if (match == null) return null;
  return { path: match[1], startLine: Number.parseInt(match[2], 10), endLine: Number.parseInt(match[3], 10) };
}

function lineRangeOverlapScore(left: Pick<FocusArea, "startLine" | "endLine">, right: Pick<FocusArea, "startLine" | "endLine">): number {
  const overlap = Math.max(0, Math.min(left.endLine, right.endLine) - Math.max(left.startLine, right.startLine) + 1);
  return overlap / Math.max(1, Math.min(left.endLine - left.startLine + 1, right.endLine - right.startLine + 1));
}

function findFocusState(area: FocusArea, states: Record<string, FocusAreaReviewState>): FocusAreaReviewState | undefined {
  const exact = states[focusAreaKey(area)];
  if (exact != null) return exact;
  let best: { score: number; distance: number; state: FocusAreaReviewState } | null = null;
  for (const [key, state] of Object.entries(states)) {
    const previous = focusAreaFromKey(key);
    if (previous == null || previous.path !== area.path) continue;
    const score = lineRangeOverlapScore(area, previous);
    const distance = Math.min(Math.abs(area.startLine - previous.startLine), Math.abs(area.endLine - previous.endLine));
    if (score < 0.5 && distance > 50) continue;
    if (best == null || score > best.score || (score === best.score && distance < best.distance)) best = { score, distance, state };
  }
  return best?.state;
}

function statesFromFocusAreas(areas: FocusArea[], viewedIds: Record<string, boolean>, collapsedIds: Record<string, boolean>, previous: Record<string, FocusAreaReviewState> = {}): Record<string, FocusAreaReviewState> {
  const now = new Date().toISOString();
  return Object.fromEntries(areas.map((area) => {
    const key = focusAreaKey(area);
    const previousState = findFocusState(area, previous);
    return [key, { viewed: viewedIds[area.id] ?? previousState?.viewed ?? false, collapsed: collapsedIds[area.id] ?? previousState?.collapsed ?? false, updatedAt: now }];
  }));
}

function idsFromFocusStates(areas: FocusArea[], states: Record<string, FocusAreaReviewState>, field: "viewed" | "collapsed"): Record<string, boolean> {
  return Object.fromEntries(areas.filter((area) => findFocusState(area, states)?.[field] === true).map((area) => [area.id, true]));
}

function focusScanHistoryPrompt(answer: string, states: Record<string, FocusAreaReviewState>): string {
  const areas = parseFocusAreas(answer);
  if (areas.length === 0) return "No previous focus scan findings are stored.";
  return areas.map((area, index) => {
    const state = findFocusState(area, states);
    const status = state?.viewed ? "reviewed" : "unreviewed";
    return `${index + 1}. ${status}: ${area.path}:${area.startLine}-${area.endLine} — ${area.title}`;
  }).join("\n");
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
  const [aiReviewId, setAiReviewId] = useState<string | null>(null);
  const [focusReview, setFocusReview] = useState<FocusReview>({ expanded: false, open: false, running: false, text: "" });
  const [focusScanId, setFocusScanId] = useState<string | null>(null);
  const [viewedFocusAreaIds, setViewedFocusAreaIds] = useState<Record<string, boolean>>({});
  const reviewCacheRef = useRef<Map<string, OpenResponse>>(new Map());
  const activeReviewKeyRef = useRef<string | null>(null);
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
  useEffect(() => {
    if (focusAreas.length === 0) return;
    setOpenFiles((current) => {
      const next = { ...current };
      let changed = false;
      for (const area of focusAreas) {
        if (next[area.path] !== true) {
          next[area.path] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [focusAreas]);
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

  function cacheReview(data: OpenResponse) {
    reviewCacheRef.current.set(data.pr.url, data);
    reviewCacheRef.current.set(data.pr.key, data);
  }

  function showReview(data: OpenResponse) {
    activeReviewKeyRef.current = data.pr.key;
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
    setAiReview({ expanded: false, open: false, running: false, text: data.aiReview?.answer ?? "", messages: data.aiReview == null ? [] : [generalReviewMessage(data.aiReview.answer)] });
    setAiReviewId(data.aiReview?.id ?? null);
    const savedAreas = parseFocusAreas(data.focusScan?.answer ?? "");
    setFocusReview({ expanded: false, open: false, running: false, text: data.focusScan?.answer ?? "" });
    setFocusScanId(data.focusScan?.id ?? null);
    setViewedFocusAreaIds(idsFromFocusStates(savedAreas, data.focusScan?.areaStates ?? {}, "viewed"));
    setActiveFocusAreaId(savedAreas[0]?.id ?? null);
    setCollapsedFocusAreaIds(idsFromFocusStates(savedAreas, data.focusScan?.areaStates ?? {}, "collapsed"));
  }

  async function openPr(nextInput: string) {
    setError(null);
    const cached = reviewCacheRef.current.get(nextInput);
    if (cached != null) {
      showReview(cached);
      void refreshLogs();
      return;
    }
    setBusy(true);
    try {
      const data = await api<OpenResponse>("/api/pr/open", { method: "POST", body: JSON.stringify({ input: nextInput }) });
      cacheReview(data);
      showReview(data);
      void runAutomaticPiReviews(data);
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
      cacheReview(data);
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
    const nextReview = { ...review, fileReviews: review.fileReviews.map((state) => state.path === file.filename ? { ...state, viewed } : state) };
    cacheReview(nextReview);
    setReview(nextReview);
    setOpenFiles({ ...openFiles, [file.filename]: !viewed });
  }

  async function saveFocusScan(answer: string, viewedIds: Record<string, boolean>, collapsedIds: Record<string, boolean>, id = focusScanId): Promise<string | null> {
    if (review == null || answer.trim().length === 0) return id;
    const { scan } = await api<{ scan: FocusScanRecord }>("/api/focus-scan/save", { method: "POST", body: JSON.stringify({ id, prKey: review.pr.key, headSha: review.pr.headSha, answer, areaStates: statesFromFocusAreas(parseFocusAreas(answer), viewedIds, collapsedIds) }) });
    setFocusScanId(scan.id);
    const nextReview = { ...review, focusScan: scan };
    cacheReview(nextReview);
    setReview(nextReview);
    return scan.id;
  }

  async function saveAiReview(answer: string, id = aiReviewId): Promise<string | null> {
    if (review == null || answer.trim().length === 0) return id;
    const { review: savedReview } = await api<{ review: AiReviewRecord }>("/api/ai-review/save", { method: "POST", body: JSON.stringify({ id, prKey: review.pr.key, headSha: review.pr.headSha, answer }) });
    setAiReviewId(savedReview.id);
    const nextReview = { ...review, aiReview: savedReview };
    cacheReview(nextReview);
    setReview(nextReview);
    return savedReview.id;
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
    const nextTarget = rangeTarget(selection.start, target);
    const dragged = draggedRef.current || (nextTarget.startLine != null && nextTarget.startLine !== nextTarget.line);
    suppressClickRef.current = dragged;
    if (dragged) openThread(nextTarget);
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

  async function submitReview(event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<boolean> {
    if (review == null || submitting) return false;
    setSubmitting(true);
    try {
      await api("/api/review/submit", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, headSha: review.pr.headSha, event, body, comments: drafts.filter((draft) => draft.line != null).map(({ path, line, startLine, side, body }) => ({ path, line, side, body, ...(startLine != null && startLine !== line ? { start_line: startLine, start_side: side } : {}) })) }) });
      setDrafts([]);
      await openPr(review.pr.url);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  async function expandNeighbor(file: PullFile, key: string, startLine: number, endLine: number) {
    if (review == null) return;
    const { text } = await api<{ text: string }>("/api/file/text", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, path: file.filename, sha: review.pr.headSha }) });
    setExpandedNeighborRows((current) => ({ ...current, [key]: contextRowsFromText(text, startLine, endLine) }));
  }

  async function runAutomaticPiReviews(nextReview: OpenResponse) {
    await Promise.all([runAiReviewFor(nextReview, true), runFocusReviewFor(nextReview, true)]);
    await refreshLogs();
  }

  async function runAiReview() {
    if (review == null || aiReview.running) return;
    await runAiReviewFor(review, false);
  }

  async function runAiReviewFor(targetReview: OpenResponse, background: boolean) {
    setAiReview((current) => ({ ...current, open: !background || current.open, expanded: !background || current.expanded, running: true }));
    const diffSummary = targetReview.files.map((file) => `## ${file.filename}
${file.patch ?? "Patch unavailable"}`).join("\n\n");
    const visibleAiReview = targetReview.pr.key === review?.pr.key ? currentGeneralReviewText(aiReview) : "";
    const previousAiReview = visibleAiReview || targetReview.aiReview?.answer.trim() || "No previous full review is stored.";
    const previousFocusAreas = targetReview.focusScan == null ? "No previous focus scan findings are stored." : focusScanHistoryPrompt(targetReview.focusScan.answer, targetReview.focusScan.areaStates);
    const prompt = `Run a concise code review for ${targetReview.pr.key}. Focus on correctness, edge cases, tests, and concrete actionable findings. Avoid generic praise. Return markdown with bullets and file/line references where possible.

Previous full review:
${previousAiReview}

Previous focus scan state:
${previousFocusAreas}

For reruns, do not repeat substantially identical findings from the previous full review or reviewed focus items unless the current diff materially changes the concern. Prefer genuinely new, unresolved, or still-unreviewed issues. If prior concerns now appear addressed, summarize that briefly instead of re-reporting them as findings.

${diffSummary}`;
    try {
      const { job } = await api<{ job: { id: string } }>("/api/pi/review", { method: "POST", body: JSON.stringify({ prKey: targetReview.pr.key, prompt }) });
      for (;;) {
        await sleep(800);
        const { job: status } = await api<{ job: { status: "running" | "complete" | "failed"; answer?: string; error?: string } }>("/api/pi/review/status", { method: "POST", body: JSON.stringify({ jobId: job.id }) });
        if (status.status === "running") continue;
        if (activeReviewKeyRef.current !== targetReview.pr.key) return;
        if (status.status === "failed") throw new Error(status.error ?? "AI review failed");
        if (status.status !== "complete") throw new Error("AI review returned an unknown job status");
        const answer = status.answer ?? "AI review completed without output.";
        setAiReview((current) => ({ ...current, open: !background || current.open, expanded: !background || current.expanded, running: false, text: answer, messages: mergeGeneralReview(current.messages, answer) }));
        void saveAiReview(answer);
        break;
      }
    } catch (err) {
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      const text = `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: !background || current.open, expanded: !background || current.expanded, running: false, text, messages: [...current.messages, { role: "pi", kind: "chat", text, title: "Review failed" }] }));
    }
  }

  async function sendAiReviewMessage(message: string) {
    if (review == null || aiReview.running || message.trim().length === 0) return;
    const question = message.trim();
    setAiReview((current) => ({ ...current, open: true, expanded: true, running: true, messages: [...current.messages, { role: "user", kind: "chat", text: question }, { role: "pi", kind: "chat", text: "" }] }));
    try {
      const previous = aiReview.messages.map((entry) => `${entry.role === "user" ? "User" : "Pi"}: ${entry.text}`).join("\n\n");
      const prompt = `Continue discussing PR ${review.pr.key}. Answer the user's latest question using the checked-out PR worktree. Be concise and cite files/lines when useful.\n\nPrevious dialogue:\n${previous || "(none)"}\n\nUser: ${question}`;
      const setAnswer = (answer: string) => setAiReview((current) => ({ ...current, open: true, expanded: true, text: answer, messages: [...current.messages.slice(0, -1), { role: "pi", kind: "chat", text: answer }] }));
      const answer = await askPiApi({ prKey: review.pr.key, prompt, purpose: "chat" }, setAnswer);
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text: answer, messages: [...current.messages.slice(0, -1), { role: "pi", kind: "chat", text: answer }] }));
    } catch (err) {
      const text = `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: true, expanded: true, running: false, text, messages: [...current.messages.slice(0, -1), { role: "pi", kind: "chat", text }] }));
    }
  }

  async function runFocusReview() {
    if (review == null || focusReview.running) return;
    await runFocusReviewFor(review, false);
  }

  async function runFocusReviewFor(targetReview: OpenResponse, background: boolean) {
    setFocusReview((current) => ({ ...current, open: !background || current.open, running: true }));
    const diffSummary = targetReview.files.map((file) => `## ${file.filename}
Status: ${file.status}, +${file.additions}/-${file.deletions}
${file.patch ?? "Patch unavailable"}`).join("\n\n");
    const previousScan = targetReview.focusScan;
    const previousFocusAreas = previousScan == null ? "No previous focus scan findings are stored." : focusScanHistoryPrompt(previousScan.answer, previousScan.areaStates);
    const prompt = `You are a second, independent PR-review pass for ${targetReview.pr.key}. Look specifically for areas worth deeper human review, not a normal exhaustive review. Prioritize:
- code that feels inconsistent with nearby codebase patterns or API conventions
- surprising behavior, hidden assumptions, edge cases, or subtle tradeoffs
- tests, migrations, performance, concurrency, or compatibility risks that deserve investigation
- places where the implementation may be valid but reviewers should explicitly decide if the tradeoff is acceptable

Previous focus scan state:
${previousFocusAreas}

If a finding is substantially the same as a previous reviewed finding, do not return it again unless the current diff materially changes the concern. If it is substantially the same as a previous unreviewed finding, keep it and use the closest current location. Prefer surfacing genuinely new or still-unreviewed findings over re-listing already-reviewed ones.

Return markdown with a "Focus areas" list. Start each item with a clickable-style location in this exact format: \`path:startLine-endLine — short title\` or \`path:line — short title\`. Then include why it is weird or worth investigation and a concrete reviewer question. Avoid generic praise and avoid blocking language unless there is strong evidence.

PR title: ${targetReview.pr.title}

${diffSummary}`;
    try {
      const { job } = await api<{ job: { id: string } }>("/api/pi/focus-review", { method: "POST", body: JSON.stringify({ prKey: targetReview.pr.key, prompt }) });
      for (;;) {
        await sleep(800);
        const { job: status } = await api<{ job: { status: "running" | "complete" | "failed"; answer?: string; error?: string } }>("/api/pi/focus-review/status", { method: "POST", body: JSON.stringify({ jobId: job.id }) });
        if (status.status === "running") continue;
        if (activeReviewKeyRef.current !== targetReview.pr.key) return;
        if (status.status === "failed") throw new Error(status.error ?? "Focus review failed");
        if (status.status !== "complete") throw new Error("Focus review returned an unknown job status");
        const answer = status.answer ?? "Focus scan completed without output.";
        const nextAreas = parseFocusAreas(answer);
        const inheritedStates = statesFromFocusAreas(focusAreas, viewedFocusAreaIds, collapsedFocusAreaIds);
        const nextViewedIds = idsFromFocusStates(nextAreas, inheritedStates, "viewed");
        const nextCollapsedIds = idsFromFocusStates(nextAreas, inheritedStates, "collapsed");
        setFocusReview((current) => ({ ...current, open: !background || current.open, running: false, text: answer }));
        setViewedFocusAreaIds(nextViewedIds);
        setCollapsedFocusAreaIds(nextCollapsedIds);
        setActiveFocusAreaId(nextAreas[0]?.id ?? null);
        void saveFocusScan(answer, nextViewedIds, nextCollapsedIds, null);
        break;
      }
    } catch (err) {
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      const text = `Focus review failed: ${err instanceof Error ? err.message : String(err)}`;
      setFocusReview((current) => ({ ...current, open: !background || current.open, running: false, text }));
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
      if (review?.pr.key === pr.key) {
        activeReviewKeyRef.current = null;
        setReview(null);
      }
      await refreshLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function goHome() {
    activeReviewKeyRef.current = null;
    setReview(null);
    setError(null);
    setDiagnostics(null);
    void refreshHistory();
  }

  function submit(event: FormEvent) { event.preventDefault(); void openPr(input); }

  function toggleAllComments(): void {
    setCommentsCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      const nextCollapsedIds = Object.fromEntries(focusAreas.map((area) => [area.id, nextCollapsed]));
      setCollapsedFocusAreaIds(nextCollapsedIds);
      void saveFocusScan(focusReview.text, viewedFocusAreaIds, nextCollapsedIds);
      return nextCollapsed;
    });
    setCommentCollapseSignal((signal) => signal + 1);
  }

  return <main className="app-shell"><header className="toolbar"><div className="toolbar-title"><strong>Pi PR Review</strong><span>{review == null ? "Paste a PR to start" : `${review.pr.key} · ${review.pr.title}`}</span></div><div className="toolbar-actions">{review != null && <><button type="button" onClick={goHome}>Home</button><button type="button" title="Pi session settings" onClick={() => { setSettingsOpen(true); void loadDiagnostics(); }}>⚙</button><button type="button" title="Pi session diagnostics" onClick={() => void showDiagnostics()}>🐞</button></>}<button type="button" title="Server log" onClick={() => { setLogsOpen(true); void refreshLogs(); }}>📜</button><select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeName)}><option value="github-dark">GitHub dark</option><option value="github-dimmed">GitHub dimmed</option><option value="github-light">GitHub light</option></select>{review != null && <form className="open-form" onSubmit={submit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="OWNER/REPO#123 or GitHub PR URL" /><button disabled={busy || input.trim().length === 0}>{busy ? "Fetching…" : "Open"}</button></form>}</div></header>{error != null && <div className="error">{error}</div>}{busy && review == null ? <div className="loading-page"><svg className="loading-cog" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20a1 1 0 0 1-1-1v-1.07A7.002 7.002 0 0 1 5.07 12H4a1 1 0 1 1 0-2h1.07A7.002 7.002 0 0 1 11 4.07V3a1 1 0 1 1 2 0v1.07A7.002 7.002 0 0 1 18.93 10H20a1 1 0 1 1 0 2h-1.07A7.002 7.002 0 0 1 13 18.93V20a1 1 0 0 1-1 1Z" /><circle cx="12" cy="12" r="3" /></svg><p>Loading pull request…</p></div> : review == null ? <StartPage prs={prs} openPr={openPr} cleanupPr={cleanupPr} openInput={input} setOpenInput={setInput} busy={busy} /> : <ReviewPage review={review} openFiles={openFiles} setOpenFiles={setOpenFiles} diffViewMode={diffViewMode} setDiffViewMode={setDiffViewMode} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} threads={threads} setThreads={setThreads} toggleThread={toggleThread} setViewed={setViewed} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} sideWidth={sideWidth} setSideWidth={setSideWidth} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} commentCollapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} toggleAllComments={toggleAllComments} aiReview={aiReview} setAiReview={setAiReview} runAiReview={runAiReview} sendAiReviewMessage={sendAiReviewMessage} focusReview={focusReview} setFocusReview={setFocusReview} runFocusReview={runFocusReview} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} viewedFocusAreaIds={viewedFocusAreaIds} setViewedFocusAreaIds={setViewedFocusAreaIds} saveFocusScan={saveFocusScan} submitReview={submitReview} submitting={submitting} refreshGithubActivity={refreshGithubActivity} refreshingActivity={refreshingActivity} />}{diagnostics != null && !settingsOpen && <DiagnosticsModal diagnostics={diagnostics} aiReview={aiReview} focusReview={focusReview} focusAreaCount={focusAreas.length} refresh={loadDiagnostics} close={() => setDiagnostics(null)} />}{review != null && settingsOpen && <PiSettingsModal prKey={review.pr.key} diagnostics={diagnostics} setDiagnostics={setDiagnostics} close={() => setSettingsOpen(false)} />}{logsOpen && <LogsModal logs={logs} refreshLogs={refreshLogs} close={() => setLogsOpen(false)} />}</main>;
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

function ReviewPage(props: DiffProps & { aiReview: AiReview; setAiReview: (review: AiReview) => void; runAiReview: () => Promise<void>; sendAiReviewMessage: (message: string) => Promise<void>; focusReview: FocusReview; setFocusReview: (review: FocusReview) => void; runFocusReview: () => Promise<void>; viewedFocusAreaIds: Record<string, boolean>; setViewedFocusAreaIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; saveFocusScan: (answer: string, viewedIds: Record<string, boolean>, collapsedIds: Record<string, boolean>) => Promise<string | null>; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<boolean>; submitting: boolean; refreshingActivity: boolean }) {
  const commentToggleLabel = props.commentsCollapsed ? "Expand all comments" : "Collapse all comments";
  const diffViewLabel = props.diffViewMode === "unified" ? "Split view" : "Unified view";
  const [sideTab, setSideTab] = useState<"review" | "pi" | "comments">("review");
  const draftCount = props.drafts.length;
  const piActivity = props.aiReview.messages.length + (props.aiReview.text.length > 0 && props.aiReview.messages.length === 0 ? 1 : 0);
  const focusCount = props.focusAreas.length;
  const piBadge = focusCount > 0 ? focusCount : piActivity > 0 ? piActivity : null;
  const commentCount = props.review.comments.length + props.review.issueComments.length + props.review.reviewSummaries.length;
  function jumpToComment(target: Target): void {
    if (props.openFiles[target.path] === false) props.setOpenFiles({ ...props.openFiles, [target.path]: true });
    if (props.commentsCollapsed) props.toggleAllComments();
    let attempts = 0;
    const maxAttempts = 20;
    const interval = 100;
    function tryScroll() {
      const thread = document.getElementById(commentThreadDomId(target));
      const row = target.line != null
        ? document.querySelector(`.diff-row[data-path="${CSS.escape(target.path)}"][data-line="${target.line}"][data-side="${target.side}"]`)
        : document.getElementById(`file-${target.path}`);
      const element = thread ?? row;
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (++attempts < maxAttempts) {
        window.setTimeout(tryScroll, interval);
      }
    }
    window.setTimeout(tryScroll, 50);
  }
  return <div className="review-layout" style={{ gridTemplateColumns: `minmax(0, 1fr) 12px ${props.sideWidth}px` }}>
    <main className="files">
      <PrHeaderStrip pr={props.review.pr} refreshGithubActivity={props.refreshGithubActivity} refreshingActivity={props.refreshingActivity} />
      <PrSummary pr={props.review.pr} />
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
        <button role="tab" aria-selected={sideTab === "review"} className={`side-tab${sideTab === "review" ? " active" : ""}`} onClick={() => setSideTab("review")}><span className="side-tab-pie" aria-hidden="true">🥧</span><span>Review</span>{draftCount > 0 && <span className="side-tab-badge">{draftCount}</span>}</button>
        <button role="tab" aria-selected={sideTab === "pi"} className={`side-tab${sideTab === "pi" ? " active" : ""}`} onClick={() => setSideTab("pi")}><span className="side-tab-pie" aria-hidden="true">π</span><span>Pi</span>{piBadge != null && <span className="side-tab-badge">{piBadge}</span>}</button>
        <button role="tab" aria-selected={sideTab === "comments"} className={`side-tab${sideTab === "comments" ? " active" : ""}`} onClick={() => setSideTab("comments")}><span className="side-tab-pie" aria-hidden="true">💬</span><span>Comments</span>{commentCount > 0 && <span className="side-tab-badge">{commentCount}</span>}</button>
      </nav>
      <div className="side-tab-panels">
        {sideTab === "review" && <ReviewSummary pr={props.review.pr} drafts={props.drafts} setDrafts={props.setDrafts} editingDraftId={props.editingDraftId} setEditingDraftId={props.setEditingDraftId} submitReview={props.submitReview} submitting={props.submitting} onJumpToDraft={(draft) => jumpToComment({ ...draft, hunk: "" })} />}
        {sideTab === "pi" && <AiReviewPanel prUrl={props.review.pr.url} review={props.aiReview} setReview={props.setAiReview} runReview={props.runAiReview} sendMessage={props.sendAiReviewMessage} focusReview={props.focusReview} runFocusReview={props.runFocusReview} focusAreas={props.focusAreas} setActiveFocusAreaId={props.setActiveFocusAreaId} collapsedFocusAreaIds={props.collapsedFocusAreaIds} setCollapsedFocusAreaIds={props.setCollapsedFocusAreaIds} viewedFocusIds={props.viewedFocusAreaIds} setViewedFocusIds={props.setViewedFocusAreaIds} saveFocusScan={props.saveFocusScan} openFiles={props.openFiles} setOpenFiles={props.setOpenFiles} />}
        {sideTab === "comments" && <ExistingComments prUrl={props.review.pr.url} comments={props.review.comments} issueComments={props.review.issueComments} reviewSummaries={props.review.reviewSummaries} refreshGithubActivity={props.refreshGithubActivity} collapseSignal={props.commentCollapseSignal} commentsCollapsed={props.commentsCollapsed} toggleAllComments={props.toggleAllComments} onJumpToComment={jumpToComment} />}
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

function PrSummary({ pr }: { pr: StoredPullRequest }) {
  const [collapsed, setCollapsed] = useState(false);
  const summary = pr.body?.trim();
  return <section className={`pr-summary github-thread${collapsed ? " minimized" : ""}`}>
    <div className="thread-head">
      <div className="thread-title">
        <Button variant="icon" aria-label={collapsed ? "Expand PR summary" : "Collapse PR summary"} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</Button>
        <div><strong>PR summary</strong><span>{summary == null || summary.length === 0 ? "No summary provided" : `${summary.split(/\s+/).slice(0, 12).join(" ")}${summary.split(/\s+/).length > 12 ? "…" : ""}`}</span></div>
      </div>
    </div>
    {!collapsed && <div className="pr-summary-body">{summary == null || summary.length === 0 ? <p className="muted">No PR summary provided.</p> : <MarkdownText text={summary} fileLinks={{ prUrl: pr.url }} />}</div>}
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

function targetIsRendered(rows: DiffRow[], target: Target): boolean {
  return rows.some((row) => target.line != null && target.side === (row.newLine != null ? "RIGHT" : "LEFT") && target.line === (row.newLine ?? row.oldLine));
}

function commentContextRows(fileText: string, target: Target): DiffRow[] {
  if (target.line == null) return [];
  const lines = fileText.split("\n");
  const start = Math.max(1, Math.min(target.startLine ?? target.line, target.line) - 3);
  const rawEnd = Math.max(target.startLine ?? target.line, target.line) + 3;
  const end = rawEnd - start > 80 ? Math.min(lines.length, target.line + 3) : Math.min(lines.length, rawEnd);
  return contextRowsFromText(fileText, start, end).map((row) => ({ ...row, hunk: "Review comment context" }));
}

function focusAreaStartIsRendered(rows: DiffRow[], area: FocusArea): boolean {
  return rows.some((row) => row.newLine === area.startLine);
}

function focusAreaContextRows(fileText: string, area: FocusArea): DiffRow[] {
  const lines = fileText.split("\n");
  const start = Math.max(1, area.startLine - 3);
  const rawEnd = area.endLine + 3;
  const end = rawEnd - start > 80 ? Math.min(lines.length, area.startLine + 3) : Math.min(lines.length, rawEnd);
  return contextRowsFromText(fileText, start, end).map((row) => ({ ...row, hunk: "Focus area context" }));
}

function uniqueRows(rows: DiffRow[]): DiffRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.oldLine ?? ""}:${row.newLine ?? ""}:${row.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function FileDiff({ file, review, openFiles, setOpenFiles, expandedContext, setExpandedContext, expandedNeighborRows, expandNeighbor, threads, setThreads, toggleThread, setViewed, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, refreshGithubActivity, commentCollapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: DiffProps & { file: PullFile }) {
  const rows = useMemo(() => parsePatchRows(file.patch), [file.patch]);
  const fileReview = review.fileReviews.find((state) => state.path === file.filename);
  const open = openFiles[file.filename] ?? true;
  const reviewCommentThreads = useMemo(() => groupReviewComments(review.comments).filter((thread) => thread[0].path === file.filename), [review.comments, file.filename]);
  const commentTargets = useMemo(() => reviewCommentThreads.map((thread) => commentTarget(thread[0])), [reviewCommentThreads]);
  const missingRightTargets = useMemo(() => commentTargets.filter((target) => target.side === "RIGHT" && target.line != null && !targetIsRendered(rows, target)), [commentTargets, rows]);
  const fileFocusAreas = useMemo(() => focusAreas.filter((area) => area.path === file.filename), [focusAreas, file.filename]);
  const missingFocusAreas = useMemo(() => fileFocusAreas.filter((area) => !focusAreaStartIsRendered(rows, area)), [fileFocusAreas, rows]);
  const [anchorFileText, setAnchorFileText] = useState<string | null>(null);
  useEffect(() => {
    if (!open || (missingRightTargets.length === 0 && missingFocusAreas.length === 0)) {
      setAnchorFileText(null);
      return;
    }
    let cancelled = false;
    api<{ text: string }>("/api/file/text", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, path: file.filename, sha: review.pr.headSha }) })
      .then(({ text }) => { if (!cancelled) setAnchorFileText(text); })
      .catch(() => { if (!cancelled) setAnchorFileText(null); });
    return () => { cancelled = true; };
  }, [open, missingRightTargets.length, missingFocusAreas.length, review.pr.url, review.pr.headSha, file.filename]);
  const commentAnchorRows = useMemo(() => anchorFileText == null ? [] : uniqueRows(missingRightTargets.flatMap((target) => commentContextRows(anchorFileText, target))), [anchorFileText, missingRightTargets]);
  const focusAnchorRows = useMemo(() => anchorFileText == null ? [] : uniqueRows(missingFocusAreas.flatMap((area) => focusAreaContextRows(anchorFileText, area))), [anchorFileText, missingFocusAreas]);
  const unrenderedCommentThreads = useMemo(() => reviewCommentThreads.filter((thread) => {
    const target = commentTarget(thread[0]);
    return !targetIsRendered(rows, target) && !targetIsRendered(commentAnchorRows, target);
  }), [reviewCommentThreads, rows, commentAnchorRows]);
  return <section className="file" id={`file-${file.filename}`}><div className="file-summary"><button className="file-summary-left" onClick={() => setOpenFiles({ ...openFiles, [file.filename]: !open })}><span className="collapse-chevron">{open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}</span><strong>{file.filename}</strong><span>{file.status} · <span className="stat-add">+{file.additions}</span> / <span className="stat-del">-{file.deletions}</span></span></button><label className="viewed-toggle" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={fileReview?.viewed ?? false} onChange={(event) => void setViewed(file, event.target.checked)} /> Viewed</label></div>{open && <><div className="patch">{rows.length === 0 ? <DiffRowView row={{ kind: "meta", oldLine: null, newLine: null, text: "Patch unavailable. Click to attach a file-level note.", hunk: "" }} target={{ path: file.filename, line: null, side: "RIGHT", hunk: "" }} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={review.comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} /> : <FoldedRows file={file} rows={rows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />}{commentAnchorRows.length > 0 && <CommentAnchorRows file={file} rows={commentAnchorRows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />}{focusAnchorRows.length > 0 && <FocusAnchorRows file={file} rows={focusAnchorRows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />}{unrenderedCommentThreads.length > 0 && <UnrenderedCommentThreads threads={unrenderedCommentThreads} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} />}</div></>}</section>;
}

function CommentAnchorRows({ file, rows, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { file: PullFile; rows: DiffRow[]; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  return <><div className="fold neighbor">Review comments outside the current diff</div>{rows.map((row, index) => <ConnectedRow key={`${file.filename}:comment-context:${index}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />)}</>;
}

function FocusAnchorRows({ file, rows, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { file: PullFile; rows: DiffRow[]; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  return <><div className="fold neighbor">Focus areas outside the current diff</div>{rows.map((row, index) => <ConnectedRow key={`${file.filename}:focus-context:${index}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />)}</>;
}

function UnrenderedCommentThreads({ threads, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed }: { threads: PullReviewComment[][]; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean }) {
  return <><div className="fold neighbor">Outdated or unavailable review comments</div>{threads.map((thread) => <ExistingReviewThread key={thread.map((comment) => comment.id).join(":")} comments={thread} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} />)}</>;
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
  const inlineCommentThreads = target == null ? [] : groupReviewComments(comments).filter((thread) => { const ct = commentTarget(thread[0]); return ct.path === target.path && ct.side === target.side && ct.line === target.line; });
  const inlineDrafts = target == null ? [] : drafts.filter((draft) => draftMatchesTarget(draft, target));
  const selecting = isTargetInSelection(target, dragSelection);
  const inThreadRange = target != null && target.line != null && Object.values(threads).some((t) => !t.collapsed && t.target.path === target.path && t.target.startLine != null && t.target.line != null && target.line! >= t.target.startLine && target.line! <= t.target.line);
  const rowFocusAreas = target == null ? [] : focusAreas.filter((area) => target.side === "RIGHT" && area.path === target.path && target.line === area.startLine);
  const language = languageForPath(target?.path);
  const hasThreadPill = thread != null || inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length > 0;
  const threadPill = hasThreadPill ? <span className="pill">{(thread == null ? 0 : 1) + inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length}</span> : null;
  const unifiedCells = <><span className="num">{row.oldLine ?? ""}</span><span className="num">{row.newLine ?? ""}</span><CodeText code={row.text} language={language} />{threadPill}</>;
  const splitCells = <><span className="num">{row.oldLine ?? ""}</span><div className="split-code old-code">{row.newLine == null || row.kind === "context" || row.kind === "hunk" || row.kind === "meta" ? <CodeText code={row.text} language={language} /> : null}</div><span className="num">{row.newLine ?? ""}</span><div className="split-code new-code">{row.oldLine == null || row.kind === "context" || row.kind === "hunk" || row.kind === "meta" ? <CodeText code={row.text} language={language} /> : null}</div>{threadPill}</>;
  return <><div className={`diff-row ${diffViewMode} ${row.kind} ${thread != null && !thread.collapsed ? "selected" : ""} ${selecting ? "range-selecting" : ""} ${inThreadRange ? "in-thread-range" : ""}`} data-path={target?.path} data-line={target?.line ?? undefined} data-side={target?.side} data-hunk={target?.hunk} onMouseDown={(event) => { if (target != null && event.button === 0) { event.preventDefault(); beginDrag(target); } }} onMouseEnter={() => { if (target != null && dragSelection != null) updateDrag(target); }} onMouseUp={() => { if (target != null) finishDrag(target); }} onClick={(event) => { if (target != null) handleRowClick(target, event.shiftKey); }}>{diffViewMode === "split" ? splitCells : unifiedCells}</div>{inlineCommentThreads.map((commentThread) => <ExistingReviewThread key={commentThread.map((comment) => comment.id).join(":")} comments={commentThread} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} />)}{rowFocusAreas.map((area) => <FocusAreaInline key={area.id} prUrl={prUrl} area={area} active={area.id === activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} askFocusArea={askFocusArea} addDraft={(body) => setDrafts([...drafts, { id: newId(), path: area.path, line: area.endLine, startLine: area.startLine, side: "RIGHT", body }])} />)}{inlineDrafts.map((draft) => <div className="inline-thread draft" key={draft.id}><DraftView draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} /></div>)}{thread != null && <ThreadBox prUrl={prUrl} thread={thread} setThread={(updatedThread) => setThreads((current) => { const next = { ...current }; delete next[thread.key]; next[updatedThread.key] = updatedThread; return next; })} closeThread={() => setThreads((current) => { const next = { ...current }; delete next[thread.key]; return next; })} addDraft={() => { if (thread.draft.trim().length > 0) setDrafts([...drafts, { id: newId(), path: thread.target.path, line: thread.target.line, startLine: thread.target.startLine, side: thread.target.side, body: thread.draft.trim() }]); setThreads((current) => { const next = { ...current }; if (thread.messages.length === 0) delete next[thread.key]; else next[thread.key] = { ...thread, draft: "", collapsed: true }; return next; }); }} askThread={askThread} />}</>;
}

function FocusAreaInline({ prUrl, area, active, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds, askFocusArea, addDraft }: { prUrl: string; area: FocusArea; active: boolean; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"]; askFocusArea: DiffProps["askFocusArea"]; addDraft: (body: string) => void }) {
  const collapsed = collapsedFocusAreaIds[area.id] ?? false;
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: "user" | "pi"; text: string }>>([]);
  void setActiveFocusAreaId;
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
  if (collapsed) return <div id={`focus-area-${area.id}`} className="inline-thread review-thread focus-area-inline focus-area-minimized focus-area-collapsed minimized" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: false }))}><div className="thread-head"><div className="thread-title"><Button variant="icon" aria-label="Expand focus area" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: false }))}><ChevronRightIcon size={16} /></Button><div><strong>Focus area</strong><span>{area.title}</span></div></div></div></div>;
  return <div id={`focus-area-${area.id}`} className={`inline-thread review-thread focus-area-inline${active ? " active" : ""}`}><div className="thread-head"><div><strong>Focus area</strong><span>{area.path}:{area.startLine === area.endLine ? area.startLine : `${area.startLine}-${area.endLine}`}</span></div><div className="actions"><Button variant="icon" aria-label="Collapse focus area" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: true }))}><ChevronDownIcon size={16} /></Button></div></div><div className="thread-messages"><div className="thread-note pi"><div className="message-role">Pi focus</div><MarkdownText text={area.body} fileLinks={{ prUrl }} /></div>{messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div>)}</div><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void ask(); } }} placeholder="Ask Pi or write a draft comment about this focus area" /><div className="actions"><button onClick={saveDraftComment} disabled={draft.trim().length === 0}>Add draft comment</button><button onClick={() => void ask()} disabled={asking || draft.trim().length === 0}>{asking ? <span className="spinner-label"><span className="spinner" aria-hidden="true" />Asking</span> : "Ask Pi"}</button></div></div></div>;
}

function ThreadBox({ prUrl, thread, setThread, closeThread, addDraft, askThread }: { prUrl: string; thread: Thread; setThread: (thread: Thread) => void; closeThread: () => void; addDraft: () => void; askThread: (thread: Thread) => Promise<void> }) {
  function updateRangeEnd(value: string) {
    const line = Number.parseInt(value, 10);
    const anchor = thread.target.startLine ?? thread.target.line;
    if (!Number.isInteger(line) || anchor == null) return;
    const target = { ...thread.target, startLine: Math.min(anchor, line), line: Math.max(anchor, line) };
    setThread({ ...thread, key: targetKey(target), target });
  }

  if (thread.collapsed) return <button className="inline-thread collapsed" onClick={() => setThread({ ...thread, collapsed: false })}><ChevronRightIcon size={14} /> Thread on {thread.target.line == null ? "file" : targetLabel(thread.target)}</button>;
  return <div className="inline-thread review-thread"><div className="thread-head"><div><strong>Line thread</strong><span>{targetLabel(thread.target)}</span></div><div className="actions">{(thread.draft.trim().length > 0 || thread.messages.length > 0) && <Button variant="icon" aria-label="Collapse thread" onClick={() => setThread({ ...thread, collapsed: true })}><ChevronDownIcon size={16} /></Button>}<Button variant="icon" className="close-thread-button" aria-label="Close thread" onClick={closeThread}><XIcon size={16} /></Button></div></div>{thread.target.line != null && <label className="range-control">End line<input type="number" min={1} value={thread.target.line} onChange={(event) => updateRangeEnd(event.target.value)} /></label>}{thread.messages.length > 0 && <div className="thread-messages">{thread.messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div>)}</div>}<div className="composer"><textarea value={thread.draft} onChange={(event) => setThread({ ...thread, draft: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && thread.draft.trim().length > 0 && !thread.asking) { event.preventDefault(); void askThread(thread); } }} placeholder="Write a draft comment or ask Pi about this line" /><div className="actions"><button onClick={addDraft} disabled={thread.draft.trim().length === 0}>Add draft comment</button><button onClick={() => void askThread(thread)} disabled={thread.asking || thread.draft.trim().length === 0}>{thread.asking ? <span className="spinner-label"><span className="spinner" aria-hidden="true" />Asking</span> : "Ask Pi"}</button></div></div></div>;
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

function ReviewSummary({ drafts, setDrafts, editingDraftId, setEditingDraftId, submitReview, submitting, onJumpToDraft }: { pr: StoredPullRequest; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<boolean>; submitting: boolean; onJumpToDraft?: (draft: DraftComment) => void }) {
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const hasReviewContent = body.trim().length > 0 || drafts.length > 0;
  const showSubmitted = submitted && !hasReviewContent;
  async function handleSubmit() {
    if (submitting || !hasReviewContent) return;
    if (await submitReview(event, body)) {
      setBody("");
      setEvent("COMMENT");
      setSubmitted(true);
    }
  }
  return <section className="panel"><h2>Draft review</h2><select className={`review-event ${event.toLowerCase().replace("_", "-")}`} value={event} onChange={(change) => { setEvent(change.target.value as typeof event); setSubmitted(false); }}><option value="COMMENT">Not reviewed</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><textarea value={body} onChange={(change) => { setBody(change.target.value); setSubmitted(false); }} placeholder="Overall review body" />{drafts.length === 0 ? <p className="muted">{showSubmitted ? "Review submitted." : "No draft comments yet."}</p> : drafts.map((draft) => <DraftView key={draft.id} draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} onJump={onJumpToDraft != null ? () => onJumpToDraft(draft) : undefined} />)}<button className={`review-submit ${event.toLowerCase().replace("_", "-")}`} disabled={submitting || !hasReviewContent} onClick={() => void handleSubmit()}>{submitting ? "Submitting…" : showSubmitted ? "Review submitted" : `Submit review (${drafts.length})`}</button></section>;
}

function AiReviewPanel({ prUrl, review, setReview, runReview, sendMessage, focusReview, runFocusReview, focusAreas, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds, viewedFocusIds, setViewedFocusIds, saveFocusScan, openFiles, setOpenFiles }: { prUrl: string; review: AiReview; setReview: (review: AiReview) => void; runReview: () => Promise<void>; sendMessage: (message: string) => Promise<void>; focusReview: FocusReview; runFocusReview: () => Promise<void>; focusAreas: FocusArea[]; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"]; viewedFocusIds: Record<string, boolean>; setViewedFocusIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; saveFocusScan: (answer: string, viewedIds: Record<string, boolean>, collapsedIds: Record<string, boolean>) => Promise<string | null>; openFiles: Record<string, boolean>; setOpenFiles: (open: Record<string, boolean>) => void }) {
  const [draft, setDraft] = useState("");
  const focusAreaCount = focusAreas.length;
  const allFocusCollapsed = focusAreaCount > 0 && focusAreas.every((area) => collapsedFocusAreaIds[area.id]);
  const hasMessages = review.messages.length > 0 || review.text.length > 0;
  const messages = review.messages.length > 0 ? review.messages : review.text.length > 0 ? [generalReviewMessage(review.text)] : [];
  const body = messages.length > 0 ? <div className="ai-chat-messages">{messages.map((message, index) => {
    const isGeneralReview = message.kind === "general-review";
    return <details className={`ai-chat-message ${message.role}${isGeneralReview ? " general-review" : ""}`} key={index} open>
      <summary><span className="message-role">{message.title ?? (message.role === "user" ? "You" : "Pi")}</span>{isGeneralReview && <span className="general-review-label">updated on each rerun</span>}</summary>
      {isGeneralReview && <p className="general-review-note">Rerunning review updates this card instead of adding a duplicate, so Pi can compare against the prior text and de-dupe findings. Follow-up chats stay below.</p>}
      <MarkdownText text={message.text} fileLinks={{ prUrl }} />
    </details>;
  })}</div> : <p className="muted">Run review or ask Pi about this PR.</p>;
  function submitChat() {
    if (draft.trim().length === 0 || review.running) return;
    const message = draft;
    setDraft("");
    void sendMessage(message);
  }
  function toggleFocusAreas(): void {
    const nextCollapsedIds = Object.fromEntries(focusAreas.map((area) => [area.id, !allFocusCollapsed]));
    setCollapsedFocusAreaIds(nextCollapsedIds);
    void saveFocusScan(focusReview.text, viewedFocusIds, nextCollapsedIds);
  }
  function jumpToFocusArea(area: FocusArea): void {
    setActiveFocusAreaId(area.id);
    const nextCollapsedIds = { ...collapsedFocusAreaIds, [area.id]: false };
    setCollapsedFocusAreaIds(nextCollapsedIds);
    void saveFocusScan(focusReview.text, viewedFocusIds, nextCollapsedIds);
    setOpenFiles({ ...openFiles, [area.path]: true });
    window.setTimeout(() => {
      const focusCard = document.getElementById(`focus-area-${area.id}`);
      const lineRow = document.querySelector(`.diff-row[data-path="${CSS.escape(area.path)}"][data-line="${area.startLine}"]`);
      (focusCard ?? lineRow)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }
  function toggleFocusViewed(area: FocusArea): void {
    const next = !viewedFocusIds[area.id];
    const nextViewedIds = { ...viewedFocusIds, [area.id]: next };
    const nextCollapsedIds = next ? { ...collapsedFocusAreaIds, [area.id]: true } : collapsedFocusAreaIds;
    setViewedFocusIds(nextViewedIds);
    if (next) setCollapsedFocusAreaIds(nextCollapsedIds);
    void saveFocusScan(focusReview.text, nextViewedIds, nextCollapsedIds);
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
    {focusReviewHasNoFindings(focusReview.text) && <div className="focus-review-note clean" role="status"><strong>✓ Nothing new to focus on.</strong><span>All scanned up for this pass.</span></div>}
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
