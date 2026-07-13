import React, { createContext, FormEvent, ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, XIcon } from "@primer/octicons-react";
import { api, askPi as askPiApi } from "./api";
import { Button } from "./components/Button";
import { CodeText, InlineSnippetsProvider, MarkdownText } from "./components/Markdown";
import { ModalShell } from "./components/Modal";
import { ExistingComments, ExistingReviewThread } from "./components/Threads";
import { buildDiffAnnotationIndex, commentTarget, commentThreadDomId, diffAnnotationTargetKey, targetKey, targetLabel, type DiffAnnotationIndex } from "./lib/comments";
import { contextRowsFromText, hunkNewStart, isTargetInSelection, lastNewLine, parsePatchRows, parsePatchSetSections, targetFromPoint, targetFromRow } from "./lib/diff";
import { autoGrowTextarea } from "./lib/dom";
import { languageForPath } from "./lib/highlight";
import { newId, prUrlFromKey, relativeTime, shortSha } from "./lib/pr";
import type { AiReview, AiReviewMessage, AiReviewRecord, DiffRow, DraftComment, DragSelection, FileReviewState, FlowDag, FocusArea, FocusAreaReviewState, FocusReview, FocusScanRecord, GpuWorkspace, GpuWorkspaceContract, GpuWorkspaceExecResult, LogEntry, OpenResponse, PiAgentActivity, PullFile, PullIssueComment, PullRequestReviewSummary, PullReviewComment, ReviewMemoryRecord, ReviewMemoryResponse, StoredPullRequest, Target, ThemeName, Thread, ThreadMessage } from "./types";
import "./styles.css";

type DiffViewMode = "unified" | "split";

type OpenPrOptions = {
  syncLocation?: boolean;
};

const homeHash = "#/";

function reviewHash(input: string): string {
  return `#/review?pr=${encodeURIComponent(input)}`;
}

function reviewInputFromHash(): string | null {
  const hash = window.location.hash || homeHash;
  if (!hash.startsWith("#/review")) return null;
  return new URLSearchParams(hash.slice(hash.indexOf("?") + 1)).get("pr");
}

function navigateHash(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}

function isPlainLeftClick(event: React.MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

const themes: Array<{ name: ThemeName; label: string; shortLabel: string }> = [
  { name: "github-dark", label: "GitHub dark", shortLabel: "Dark" },
  { name: "github-dimmed", label: "GitHub dimmed", shortLabel: "Dimmed" },
  { name: "github-light", label: "GitHub light", shortLabel: "Light" },
];

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
  askFocusArea: (area: FocusArea, question: string, onDelta?: (answer: string) => void, onActivity?: (activity: PiAgentActivity | null) => void) => Promise<string>;
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

const DiffAnnotationsContext = createContext<DiffAnnotationIndex>(buildDiffAnnotationIndex([], [], {}, []));

type PiPanelProps = {
  review: AiReview;
  aiReviewHistory: AiReviewRecord[];
  aiReviewId: string | null;
  showAiReviewRecord: (record: AiReviewRecord | null | undefined) => void;
  runReview: () => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  chatSending: boolean;
  clearFollowUp: () => void;
  copyFeedbackPrompt: (overallBody?: string) => Promise<void>;
  focusReview: FocusReview;
  focusScanHistory: FocusScanRecord[];
  focusScanId: string | null;
  showFocusScanRecord: (record: FocusScanRecord | null | undefined) => void;
  runFocusReview: () => Promise<void>;
  viewedFocusIds: Record<string, boolean>;
  setViewedFocusIds: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  saveFocusScan: (answer: string, viewedIds: Record<string, boolean>, collapsedIds: Record<string, boolean>) => Promise<string | null>;
};

function focusReviewHasNoFindings(text: string): boolean {
  return text.trim().length > 0 && parseFocusAreas(text).length === 0;
}

function generalReviewMessage(text: string): AiReviewMessage {
  return { role: "pi", kind: "general-review", title: "General review", text };
}

function currentGeneralReviewText(review: AiReview): string {
  return review.messages.find((message) => message.kind === "general-review")?.text.trim() ?? (review.messages.length === 0 ? review.text.trim() : "");
}

function currentAiReviewMessages(review: AiReview): AiReviewMessage[] {
  return review.messages.length > 0 ? review.messages : review.text.trim().length > 0 ? [generalReviewMessage(review.text)] : [];
}

function messagesFromAiReviewRecord(review: AiReviewRecord | null | undefined): AiReviewMessage[] {
  if (review == null) return [];
  if (review.messages != null && review.messages.length > 0) return review.messages;
  return review.answer.trim().length > 0 ? [generalReviewMessage(review.answer)] : [];
}

function historyTimestamp(record: { updatedAt: string; createdAt: string }): string {
  const date = new Date(record.updatedAt || record.createdAt);
  return Number.isNaN(date.getTime()) ? record.updatedAt || record.createdAt : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function firstUserQuestionText(messages: AiReviewMessage[] | undefined): string {
  return messages?.find((message) => message.role === "user")?.text.trim() ?? "";
}

function chatQuestionCount(messages: AiReviewMessage[] | undefined): number {
  return messages?.filter((message) => message.role === "user").length ?? 0;
}

function focusScanSummary(record: FocusScanRecord): string {
  const areas = parseFocusAreas(record.answer);
  if (areas.length > 0) return `${areas.length} focus ${areas.length === 1 ? "area" : "areas"}`;
  return record.answer.trim().length === 0 ? "Not yet scanned" : "Clean — no focus areas";
}

function threadDialogue(messages: ThreadMessage[]): string {
  return messages.map((message) => `${message.role === "user" ? "User" : "Pi"}: ${message.text}`).join("\n\n");
}

function writeClipboardFallback(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard != null) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      writeClipboardFallback(text);
      return;
    }
  }
  writeClipboardFallback(text);
}

function draftDiffHunk(files: PullFile[], draft: DraftComment): string {
  const file = files.find((candidate) => candidate.filename === draft.path);
  if (file?.patch == null) return "Patch unavailable.";
  const lineForSide = (row: DiffRow) => draft.side === "RIGHT" ? row.newLine : row.oldLine;
  return parsePatchRows(file.patch).find((row) => draft.line != null && lineForSide(row) === draft.line)?.hunk ?? "Patch hunk unavailable for this draft anchor.";
}

function reviewDraftContext(pr: StoredPullRequest, files: PullFile[], body: string, drafts: DraftComment[]): string {
  const overallBody = body.trim().length > 0 ? body.trim() : "(none)";
  const draftBlocks = drafts.map((draft, index) => `## Draft comment ${index + 1}

Location: ${draftLocation(draft)}
Side: ${draft.side}

Comment:
${draft.body}

Diff hunk context:
\`\`\`diff
${draftDiffHunk(files, draft)}
\`\`\``);
  return `# PR review draft context

PR: ${pr.key}
URL: ${pr.url}
Title: ${pr.title}
Head: ${pr.headSha}

Overall review body:
${overallBody}

${draftBlocks.join("\n\n")}`;
}

function commentAuthor(comment: PullReviewComment | PullIssueComment | PullRequestReviewSummary): string {
  return comment.user?.login ?? "github";
}

function commentUpdatedAt(comment: PullReviewComment | PullIssueComment | PullRequestReviewSummary): string | undefined {
  if ("submitted_at" in comment && comment.submitted_at != null) return comment.submitted_at;
  return comment.updated_at;
}

function reviewFeedbackPromptPayload(review: OpenResponse, drafts: DraftComment[], overallBody: string, aiReview: AiReview, focusReview: FocusReview, focusAreas: FocusArea[], viewedFocusIds: Record<string, boolean>): Record<string, unknown> {
  const localReviewComments = [overallBody.trim().length > 0 ? { kind: "Local overall review", author: "You", body: overallBody.trim() } : null, ...drafts.filter((draft) => draft.body.trim().length > 0).map((draft) => ({ kind: "Local draft comment", author: "You", body: draft.body.trim(), location: draftLocation(draft) }))].filter((comment) => comment != null);
  const reviewSummaries = review.reviewSummaries.filter((comment) => comment.body.trim().length > 0).map((comment) => ({ kind: `Review summary (${comment.state.toLowerCase().replace("_", " ")})`, author: commentAuthor(comment), body: comment.body.trim(), url: comment.html_url, updatedAt: commentUpdatedAt(comment) }));
  const issueComments = review.issueComments.filter((comment) => comment.body.trim().length > 0).map((comment) => ({ kind: "Conversation comment", author: commentAuthor(comment), body: comment.body.trim(), url: comment.html_url, updatedAt: commentUpdatedAt(comment) }));
  const reviewComments = review.comments.filter((comment) => comment.body.trim().length > 0).map((comment) => ({ kind: comment.in_reply_to_id == null ? "Inline review comment" : "Inline review reply", author: commentAuthor(comment), body: comment.body.trim(), location: targetLabel(commentTarget(comment)), state: comment.thread_resolved == null ? undefined : comment.thread_resolved ? "resolved thread" : "unresolved thread", url: comment.html_url, updatedAt: commentUpdatedAt(comment) }));
  return {
    mode: "review-feedback",
    prKey: review.pr.key,
    prTitle: review.pr.title,
    prUrl: review.pr.url,
    headSha: review.pr.headSha,
    userComments: [...localReviewComments, ...reviewSummaries, ...issueComments, ...reviewComments],
    aiComments: currentAiReviewMessages(aiReview).filter((message) => message.kind !== "general-review" && message.text.trim().length > 0).map(({ role, text, title, kind }) => ({ role, text: text.trim(), title, kind })),
    focusAreas: focusAreas.map((area) => ({ path: area.path, startLine: area.startLine, endLine: area.endLine, title: area.title, body: area.body, viewed: viewedFocusIds[area.id] === true })),
    globalFeedback: currentGeneralReviewText(aiReview),
    focusScan: focusReview.text,
  };
}

function upsertHistoryRecord<T extends { id: string; updatedAt: string; createdAt: string }>(records: T[], record: T): T[] {
  return [record, ...records.filter((stored) => stored.id !== record.id)].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
}

function draftLocation(draft: DraftComment): string {
  return `${draft.path}:${draft.line == null ? "file" : draft.startLine != null && draft.startLine !== draft.line ? `${draft.startLine}-${draft.line}` : draft.line}`;
}

function draftSubmitBlocker(files: PullFile[], draft: DraftComment): string | null {
  if (draft.line == null) return null;
  const file = files.find((candidate) => candidate.filename === draft.path);
  if (file == null || file.patch == null) return "file is not in the loaded PR diff";
  const lineForRow = (row: DiffRow) => draft.side === "RIGHT" ? row.newLine : row.oldLine;
  const rows = parsePatchRows(file.patch);
  const endRow = rows.find((row) => lineForRow(row) === draft.line);
  if (endRow == null) return "end line is outside GitHub's diff hunks";
  if (draft.startLine == null || draft.startLine === draft.line) return null;
  const startRow = rows.find((row) => lineForRow(row) === draft.startLine);
  if (startRow == null) return "start line is outside GitHub's diff hunks";
  return startRow.hunk === endRow.hunk ? null : "range crosses GitHub diff hunks";
}

function invalidDraftDetails(files: PullFile[], drafts: DraftComment[]): Array<{ index: number; draft: DraftComment; reason: string }> {
  return drafts.map((draft, index) => ({ index, draft, reason: draftSubmitBlocker(files, draft) })).filter((item): item is { index: number; draft: DraftComment; reason: string } => item.reason != null);
}

function invalidDraftMessage(details: Array<{ index: number; draft: DraftComment; reason: string }>): string {
  return `Some draft comments cannot be submitted to GitHub because their saved line anchors are not valid review positions. I highlighted them in Draft review. Delete or recreate these drafts on visible diff lines, then retry:\n${details.map(({ index, draft, reason }) => `Draft #${index + 1}: ${draftLocation(draft)} — ${reason}`).join("\n")}`;
}

function draftIdsFromSubmitError(message: string, drafts: DraftComment[]): Record<string, boolean> {
  const ids = Object.fromEntries([...message.matchAll(/draft=([^\s]+)/g)].map((match) => [match[1], true]));
  if (Object.keys(ids).length > 0) return ids;
  return Object.fromEntries(drafts.filter((draft) => message.includes(draftLocation(draft)) || message.includes(draft.body.trim().slice(0, 80))).map((draft) => [draft.id, true]));
}

function focusAreaPath(path: string) {
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

async function loadPiAgentActivityForPr(prKey: string, purpose: string, fallback: PiAgentActivity | null): Promise<PiAgentActivity | null> {
  const data = await api<{ diagnostics: { sessions?: unknown[] } }>("/api/pi/diagnostics", { method: "POST", body: JSON.stringify({ prKey }) });
  const session = data.diagnostics.sessions?.find((item): item is Record<string, unknown> => typeof item === "object" && item != null && (item as Record<string, unknown>).purpose === purpose);
  return session == null ? fallback : diagnosticsAgentActivity(session, fallback);
}

function startPiAgentActivityPolling(prKey: string, purpose: string, onActivity: (activity: PiAgentActivity | null) => void, fallback: PiAgentActivity | null = runningAgentActivity(purpose)): () => void {
  let cancelled = false;
  const pollActivity = async () => {
    while (!cancelled) {
      await sleep(1000);
      if (!cancelled) onActivity(await loadPiAgentActivityForPr(prKey, purpose, fallback));
    }
  };
  void pollActivity();
  return () => { cancelled = true; };
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
  const [reviewEvent, setReviewEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [reviewBody, setReviewBody] = useState("");
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [invalidDraftIds, setInvalidDraftIds] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [aiReview, setAiReview] = useState<AiReview>({ expanded: false, open: false, running: false, text: "", messages: [] });
  const [aiChatSending, setAiChatSending] = useState(false);
  const [aiReviewId, setAiReviewId] = useState<string | null>(null);
  const [focusReview, setFocusReview] = useState<FocusReview>({ expanded: false, open: false, running: false, text: "" });
  const [focusScanId, setFocusScanId] = useState<string | null>(null);
  const [flowDag, setFlowDag] = useState<FlowDag>({ running: false, text: "", error: null });
  const [flowDagOpen, setFlowDagOpen] = useState(false);
  const [viewedFocusAreaIds, setViewedFocusAreaIds] = useState<Record<string, boolean>>({});
  const reviewCacheRef = useRef<Map<string, OpenResponse>>(new Map());
  const activeReviewKeyRef = useRef<string | null>(null);
  const pendingOpenRef = useRef<{ input: string; requestId: number } | null>(null);
  const openRequestIdRef = useRef(0);
  const [activeFocusAreaId, setActiveFocusAreaId] = useState<string | null>(null);
  const [collapsedFocusAreaIds, setCollapsedFocusAreaIds] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [refreshingActivity, setRefreshingActivity] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sideWidth, setSideWidth] = useState(560);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [reviewMemory, setReviewMemory] = useState<ReviewMemoryResponse | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDistilling, setMemoryDistilling] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => localStorage.getItem("pi-review-theme") as ThemeName || "github-dark");
  const [commentCollapseSignal, setCommentCollapseSignal] = useState(0);
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [gpuWorkspaceOpen, setGpuWorkspaceOpen] = useState(false);

  async function refreshHistory() { setPrs((await api<{ prs: StoredPullRequest[] }>("/api/prs")).prs); }
  async function refreshLogs() { setLogs((await api<{ logs: LogEntry[] }>("/api/logs")).logs.slice(-40).reverse()); }

  useEffect(() => { refreshHistory().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))); refreshLogs().catch(() => undefined); }, []);

  useEffect(() => {
    function openRoute() {
      const routedInput = reviewInputFromHash();
      if (routedInput == null) {
        goHome();
        return;
      }
      void openPr(routedInput, { syncLocation: false });
    }
    openRoute();
    window.addEventListener("hashchange", openRoute);
    return () => window.removeEventListener("hashchange", openRoute);
  }, []);

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

  function updateCachedReview(prKey: string, update: (current: OpenResponse) => OpenResponse): OpenResponse | null {
    const current = reviewCacheRef.current.get(prKey) ?? (review?.pr.key === prKey ? review : null);
    if (current == null) return null;
    const next = update(current);
    cacheReview(next);
    if (activeReviewKeyRef.current === prKey) setReview(next);
    return next;
  }

  function showAiReviewRecord(record: AiReviewRecord | null | undefined) {
    setAiReview({ expanded: false, open: false, running: false, text: record?.answer ?? "", messages: messagesFromAiReviewRecord(record) });
    setAiReviewId(record?.id ?? null);
  }

  function showFocusScanRecord(record: FocusScanRecord | null | undefined) {
    const savedAreas = parseFocusAreas(record?.answer ?? "");
    setFocusReview({ expanded: false, open: false, running: false, text: record?.answer ?? "" });
    setFocusScanId(record?.id ?? null);
    setViewedFocusAreaIds(idsFromFocusStates(savedAreas, record?.areaStates ?? {}, "viewed"));
    setActiveFocusAreaId(savedAreas[0]?.id ?? null);
    setCollapsedFocusAreaIds(idsFromFocusStates(savedAreas, record?.areaStates ?? {}, "collapsed"));
  }

  function initialOpenFiles(data: OpenResponse): Record<string, boolean> {
    return Object.fromEntries(data.files.map((file) => [file.filename, !file.generated && !data.fileReviews.find((state) => state.path === file.filename)?.viewed]));
  }

  function showReview(data: OpenResponse) {
    activeReviewKeyRef.current = data.pr.key;
    setReview(data);
    setInput(data.pr.url);
    setOpenFiles(initialOpenFiles(data));
    setThreads({});
    setActiveTarget(null);
    dragSelectionRef.current = null;
    setDragSelection(null);
    setDrafts(data.draftReview?.comments ?? []);
    setReviewEvent(data.draftReview?.event ?? "COMMENT");
    setReviewBody(data.draftReview?.body ?? "");
    setExpandedNeighborRows({});
    setEditingDraftId(null);
    setInvalidDraftIds({});
    showAiReviewRecord(data.aiReview);
    showFocusScanRecord(data.focusScan);
    setFlowDag({ running: false, text: "", error: null });
    setFlowDagOpen(false);
    setGpuWorkspaceOpen(false);
  }

  async function openPr(nextInput: string, options: OpenPrOptions = {}) {
    if (pendingOpenRef.current?.input === nextInput && pendingOpenRef.current.requestId === openRequestIdRef.current) return;
    const requestId = ++openRequestIdRef.current;
    if (options.syncLocation !== false) navigateHash(reviewHash(nextInput));
    setError(null);
    const cached = reviewCacheRef.current.get(nextInput);
    if (cached != null) {
      showReview(cached);
      setBusy(false);
      void refreshLogs();
      return;
    }
    pendingOpenRef.current = { input: nextInput, requestId };
    setBusy(true);
    try {
      const data = await api<OpenResponse>("/api/pr/open", { method: "POST", body: JSON.stringify({ input: nextInput }) });
      cacheReview(data);
      if (requestId !== openRequestIdRef.current) return;
      showReview(data);
      if (options.syncLocation !== false) navigateHash(reviewHash(data.pr.url));
      void runAutomaticPiReviews(data);
      await Promise.all([refreshHistory(), refreshLogs()]);
    } catch (err) {
      if (requestId === openRequestIdRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (pendingOpenRef.current?.requestId === requestId) pendingOpenRef.current = null;
      if (requestId === openRequestIdRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    if (review == null || (review.draftReview == null && reviewEvent === "COMMENT" && reviewBody.length === 0 && drafts.length === 0)) return;
    const timeout = window.setTimeout(() => {
      void api<{ draftReview: OpenResponse["draftReview"] }>("/api/draft-review/save", { method: "POST", body: JSON.stringify({ prKey: review.pr.key, headSha: review.pr.headSha, event: reviewEvent, body: reviewBody, comments: drafts }) })
        .then(({ draftReview }) => updateCachedReview(review.pr.key, (current) => ({ ...current, draftReview })))
        .catch((err: unknown) => setError(`Saving draft review failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [review?.pr.key, review?.pr.headSha, reviewEvent, reviewBody, drafts]);

  async function refreshGithubActivity() {
    if (review == null) return;
    setRefreshingActivity(true);
    setError(null);
    try {
      const data = await api<OpenResponse>("/api/pr/activity", { method: "POST", body: JSON.stringify({ input: review.pr.url }) });
      cacheReview(data);
      setReview(data);
      setOpenFiles((current) => ({ ...initialOpenFiles(data), ...current }));
      showAiReviewRecord(data.aiReview);
      showFocusScanRecord(data.focusScan);
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
    updateCachedReview(review.pr.key, (current) => ({ ...current, focusScan: scan, focusScans: upsertHistoryRecord(current.focusScans, scan) }));
    return scan.id;
  }

  async function saveAiReviewFor(targetReview: OpenResponse, answer: string, messages: AiReviewMessage[], id: string | null = targetReview.aiReview?.id ?? null): Promise<string | null> {
    if (answer.trim().length === 0) return id;
    const { review: savedReview } = await api<{ review: AiReviewRecord }>("/api/ai-review/save", { method: "POST", body: JSON.stringify({ id, prKey: targetReview.pr.key, headSha: targetReview.pr.headSha, answer, messages }) });
    const nextReview = updateCachedReview(targetReview.pr.key, (current) => ({ ...current, aiReview: savedReview, aiReviews: upsertHistoryRecord(current.aiReviews, savedReview) }));
    if (activeReviewKeyRef.current === targetReview.pr.key && nextReview != null) setAiReviewId(savedReview.id);
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

  async function loadPiAgentActivity(purpose: string, fallback: PiAgentActivity | null): Promise<PiAgentActivity | null> {
    return review == null ? fallback : loadPiAgentActivityForPr(review.pr.key, purpose, fallback);
  }

  async function askFocusArea(area: FocusArea, question: string, onDelta?: (answer: string) => void, onActivity?: (activity: PiAgentActivity | null) => void): Promise<string> {
    if (review == null) return "Open a PR before asking Pi.";
    const { prompt, purpose } = await buildPiPrompt({ mode: "focus-chat", prKey: review.pr.key, path: area.path, startLine: area.startLine, endLine: area.endLine, body: area.body, question });
    let cancelled = false;
    const pollActivity = async () => {
      while (!cancelled) {
        await sleep(1000);
        if (cancelled) return;
        onActivity?.(await loadPiAgentActivity(purpose, null));
      }
    };
    void pollActivity();
    try {
      return await askPiApi({ prKey: review.pr.key, prompt, purpose }, onDelta);
    } finally {
      cancelled = true;
      await refreshLogs();
    }
  }

  async function askThread(thread: Thread) {
    if (review == null || thread.draft.trim().length === 0) return;
    const question = thread.draft.trim();
    setThreads((current) => ({ ...current, [thread.key]: { ...thread, asking: true, activity: runningAgentActivity("inline-chat"), draft: "", messages: [...thread.messages, { role: "user", text: question }, { role: "pi", text: "" }] } }));
    let cancelActivityPolling = () => undefined;
    try {
      const previousDialogue = threadDialogue(thread.messages);
      const { prompt, purpose } = await buildPiPrompt({ mode: "inline-chat", prKey: review.pr.key, path: thread.target.path, line: thread.target.line, startLine: thread.target.startLine, side: thread.target.side, hunk: thread.target.hunk, previousDialogue: previousDialogue.length > 0 ? previousDialogue : undefined, question });
      let cancelled = false;
      cancelActivityPolling = () => { cancelled = true; };
      const pollActivity = async () => {
        while (!cancelled) {
          await sleep(1000);
          if (cancelled) return;
          const activity = await loadPiAgentActivity(purpose, null);
          setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], activity: activity ?? current[thread.key]?.activity ?? null } }));
        }
      };
      void pollActivity();
      const setAnswer = (answer: string) => setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], activity: streamingAgentActivity(current[thread.key]?.activity, answer), messages: [...(current[thread.key]?.messages ?? []).slice(0, -1), { role: "pi", text: answer }] } }));
      const answer = await askPiApi({ prKey: review.pr.key, prompt, purpose }, setAnswer);
      cancelActivityPolling();
      setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], asking: false, activity: null, messages: [...(current[thread.key]?.messages ?? []).slice(0, -1), { role: "pi", text: answer }] } }));
      await refreshLogs();
    } catch (err) {
      cancelActivityPolling();
      const text = `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}`;
      setThreads((current) => ({ ...current, [thread.key]: { ...current[thread.key], asking: false, activity: null, messages: [...(current[thread.key]?.messages ?? []).slice(0, -1), { role: "pi", text }] } }));
    }
  }

  async function submitReview(event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string): Promise<boolean> {
    if (review == null || submitting) return false;
    const invalidDrafts = invalidDraftDetails(review.files, drafts);
    if (invalidDrafts.length > 0) {
      setInvalidDraftIds(Object.fromEntries(invalidDrafts.map(({ draft }) => [draft.id, true])));
      setError(invalidDraftMessage(invalidDrafts));
      return false;
    }
    setInvalidDraftIds({});
    setSubmitting(true);
    try {
      await api("/api/review/submit", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, headSha: review.pr.headSha, event, body, comments: drafts.filter((draft) => draft.line != null).map(({ id, path, line, startLine, side, body }) => ({ draft_id: id, path, line, side, body, ...(startLine != null && startLine !== line ? { start_line: startLine, start_side: side } : {}) })) }) });
      setDrafts([]);
      await openPr(review.pr.url);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setInvalidDraftIds(draftIdsFromSubmitError(message, drafts));
      setError(message);
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

  async function buildPiPrompt(payload: Record<string, unknown>): Promise<{ prompt: string; purpose: string }> {
    return await api<{ prompt: string; purpose: string }>("/api/pi/prompt", { method: "POST", body: JSON.stringify(payload) });
  }

  async function copyReviewFeedbackPrompt(overallBody = ""): Promise<void> {
    if (review == null) return;
    const { prompt } = await buildPiPrompt(reviewFeedbackPromptPayload(review, drafts, overallBody, aiReview, focusReview, focusAreas, viewedFocusAreaIds));
    await writeClipboard(prompt);
  }

  async function runAutomaticPiReviews(nextReview: OpenResponse) {
    const aiReviewUpToDate = nextReview.aiReview != null && nextReview.aiReview.headSha === nextReview.pr.headSha && nextReview.aiReview.answer.trim().length > 0;
    const focusScanUpToDate = nextReview.focusScan != null && nextReview.focusScan.headSha === nextReview.pr.headSha && nextReview.focusScan.answer.trim().length > 0;
    await Promise.all([
      aiReviewUpToDate ? Promise.resolve() : runAiReviewFor(nextReview, true),
      focusScanUpToDate ? Promise.resolve() : runFocusReviewFor(nextReview, true),
    ]);
    await refreshLogs();
  }

  async function runAiReview() {
    if (review == null || aiReview.running) return;
    await runAiReviewFor(review, false);
  }

  async function runFlowDag() {
    if (review == null || flowDag.running) return;
    const targetReview = review;
    const initialActivity = runningAgentActivity("flow-dag");
    let cancelActivityPolling: () => void = () => undefined;
    setFlowDagOpen(true);
    setFlowDag({ running: true, text: "", error: null, activity: initialActivity });
    try {
      const { prompt, purpose } = await buildPiPrompt({ mode: "code-walk", prKey: targetReview.pr.key, prTitle: targetReview.pr.title, files: targetReview.files });
      cancelActivityPolling = startPiAgentActivityPolling(targetReview.pr.key, purpose, (activity) => {
        if (activeReviewKeyRef.current === targetReview.pr.key) setFlowDag((current) => ({ ...current, activity: activity ?? current.activity ?? null }));
      }, initialActivity);
      const setAnswer = (answer: string) => {
        if (activeReviewKeyRef.current !== targetReview.pr.key) return;
        setFlowDag((current) => ({ running: true, text: answer, error: null, activity: streamingAgentActivity(current.activity, answer) }));
      };
      const answer = await askPiApi({ prKey: targetReview.pr.key, prompt, purpose }, setAnswer);
      cancelActivityPolling();
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      setFlowDag({ running: false, text: answer, error: null, activity: null });
      await refreshLogs();
    } catch (err) {
      cancelActivityPolling();
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      setFlowDag((current) => ({ running: false, text: current.text, error: err instanceof Error ? err.message : String(err), activity: null }));
    }
  }

  async function runAiReviewFor(targetReview: OpenResponse, background: boolean) {
    setAiReview((current) => ({ ...current, open: !background || current.open, expanded: !background || current.expanded, running: true, text: background ? current.text : "", messages: background ? current.messages : [], activity: null }));
    const visibleAiReview = targetReview.pr.key === review?.pr.key ? currentGeneralReviewText(aiReview) : "";
    const previousAiReview = visibleAiReview || targetReview.aiReview?.answer.trim() || "No previous full review is stored.";
    const previousFocusAreas = targetReview.focusScan == null ? "No previous focus scan findings are stored." : focusScanHistoryPrompt(targetReview.focusScan.answer, targetReview.focusScan.areaStates);
    try {
      const { prompt } = await buildPiPrompt({ mode: "main-review", prKey: targetReview.pr.key, previousAiReview, previousFocusAreas, files: targetReview.files });
      const { job } = await api<{ job: { id: string } }>("/api/pi/review", { method: "POST", body: JSON.stringify({ prKey: targetReview.pr.key, prompt }) });
      for (;;) {
        await sleep(800);
        const { job: status } = await api<{ job: { status: "running" | "complete" | "failed"; answer?: string; error?: string; activity?: PiAgentActivity } }>("/api/pi/review/status", { method: "POST", body: JSON.stringify({ jobId: job.id }) });
        if (status.status === "running") {
          if (activeReviewKeyRef.current === targetReview.pr.key) setAiReview((current) => ({ ...current, activity: status.activity ?? current.activity ?? null }));
          continue;
        }
        if (activeReviewKeyRef.current !== targetReview.pr.key) return;
        if (status.status === "failed") throw new Error(status.error ?? "AI review failed");
        if (status.status !== "complete") throw new Error("AI review returned an unknown job status");
        const answer = status.answer ?? "AI review completed without output.";
        const nextMessages: AiReviewMessage[] = [generalReviewMessage(answer)];
        setAiReview((current) => ({ ...current, open: !background || current.open, expanded: !background || current.expanded, running: false, text: answer, messages: nextMessages, activity: null }));
        void saveAiReviewFor(targetReview, answer, nextMessages, null);
        break;
      }
    } catch (err) {
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      const text = `AI review failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: !background || current.open, expanded: !background || current.expanded, running: false, text, messages: [...current.messages, { role: "pi", kind: "chat", text, title: "Review failed" }], activity: null }));
    }
  }

  async function sendAiReviewMessage(message: string) {
    if (review == null || aiChatSending || message.trim().length === 0) return;
    const targetReview = review;
    const startingReview = aiReview;
    const question = message.trim();
    const initialActivity = runningAgentActivity("chat");
    let cancelActivityPolling: () => void = () => undefined;
    setAiChatSending(true);
    setAiReview((current) => ({ ...current, open: true, expanded: true, activity: initialActivity, messages: [...current.messages, { role: "user", kind: "chat", text: question }, { role: "pi", kind: "chat", text: "" }] }));
    try {
      const previousDialogue = startingReview.messages.filter((entry) => entry.kind !== "general-review").map((entry) => `${entry.role === "user" ? "User" : "Pi"}: ${entry.text}`).join("\n\n");
      const { prompt, purpose } = await buildPiPrompt({ mode: "ai-chat", prKey: targetReview.pr.key, previousDialogue: previousDialogue || "(none)", question });
      cancelActivityPolling = startPiAgentActivityPolling(targetReview.pr.key, purpose, (activity) => {
        if (activeReviewKeyRef.current === targetReview.pr.key) setAiReview((current) => ({ ...current, activity: activity ?? current.activity ?? null }));
      }, initialActivity);
      const setAnswer = (answer: string) => {
        if (activeReviewKeyRef.current !== targetReview.pr.key) return;
        setAiReview((current) => ({ ...current, open: true, expanded: true, activity: streamingAgentActivity(current.activity, answer), messages: [...current.messages.slice(0, -1), { role: "pi", kind: "chat", text: answer }] }));
      };
      const answer = await askPiApi({ prKey: targetReview.pr.key, prompt, purpose }, setAnswer);
      cancelActivityPolling();
      const nextMessages: AiReviewMessage[] = [...startingReview.messages, { role: "user", kind: "chat", text: question }, { role: "pi", kind: "chat", text: answer }];
      if (activeReviewKeyRef.current === targetReview.pr.key) setAiReview((current) => ({ ...current, open: true, expanded: true, activity: null, messages: nextMessages }));
      void saveAiReviewFor(targetReview, currentGeneralReviewText({ ...startingReview, text: answer, messages: nextMessages }) || answer, nextMessages, aiReviewId);
    } catch (err) {
      cancelActivityPolling();
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      const text = `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}`;
      setAiReview((current) => ({ ...current, open: true, expanded: true, activity: null, messages: [...current.messages.slice(0, -1), { role: "pi", kind: "chat", text }] }));
    } finally {
      if (activeReviewKeyRef.current === targetReview.pr.key) setAiChatSending(false);
    }
  }

  function clearAiReviewFollowUp(): void {
    if (review == null || aiChatSending) return;
    const targetReview = review;
    const keptMessages = aiReview.messages.filter((message) => message.kind === "general-review");
    setAiReview((current) => ({ ...current, messages: keptMessages }));
    void saveAiReviewFor(targetReview, currentGeneralReviewText({ ...aiReview, messages: keptMessages }) || aiReview.text, keptMessages, aiReviewId);
  }

  async function runFocusReview() {
    if (review == null || focusReview.running) return;
    await runFocusReviewFor(review, false);
  }

  async function runFocusReviewFor(targetReview: OpenResponse, background: boolean) {
    setFocusReview((current) => ({ ...current, open: !background || current.open, running: true, text: background ? current.text : "", activity: null }));
    if (!background) {
      setViewedFocusAreaIds({});
      setActiveFocusAreaId(null);
      setCollapsedFocusAreaIds({});
    }
    const previousScan = targetReview.focusScan;
    const previousFocusAreas = previousScan == null ? "No previous focus scan findings are stored." : focusScanHistoryPrompt(previousScan.answer, previousScan.areaStates);
    try {
      const { prompt } = await buildPiPrompt({ mode: "focus-review", prKey: targetReview.pr.key, prTitle: targetReview.pr.title, previousFocusAreas, files: targetReview.files });
      const { job } = await api<{ job: { id: string } }>("/api/pi/focus-review", { method: "POST", body: JSON.stringify({ prKey: targetReview.pr.key, prompt }) });
      for (;;) {
        await sleep(800);
        const { job: status } = await api<{ job: { status: "running" | "complete" | "failed"; answer?: string; error?: string; activity?: PiAgentActivity } }>("/api/pi/focus-review/status", { method: "POST", body: JSON.stringify({ jobId: job.id }) });
        if (status.status === "running") {
          if (activeReviewKeyRef.current === targetReview.pr.key) setFocusReview((current) => ({ ...current, activity: status.activity ?? current.activity ?? null }));
          continue;
        }
        if (activeReviewKeyRef.current !== targetReview.pr.key) return;
        if (status.status === "failed") throw new Error(status.error ?? "Focus review failed");
        if (status.status !== "complete") throw new Error("Focus review returned an unknown job status");
        const answer = status.answer ?? "Focus scan completed without output.";
        const nextAreas = parseFocusAreas(answer);
        const inheritedStates = statesFromFocusAreas(focusAreas, viewedFocusAreaIds, collapsedFocusAreaIds);
        const nextViewedIds = idsFromFocusStates(nextAreas, inheritedStates, "viewed");
        const nextCollapsedIds = idsFromFocusStates(nextAreas, inheritedStates, "collapsed");
        setFocusReview((current) => ({ ...current, open: !background || current.open, running: false, text: answer, activity: null }));
        setViewedFocusAreaIds(nextViewedIds);
        setCollapsedFocusAreaIds(nextCollapsedIds);
        setActiveFocusAreaId(nextAreas[0]?.id ?? null);
        void saveFocusScan(answer, nextViewedIds, nextCollapsedIds, null);
        break;
      }
    } catch (err) {
      if (activeReviewKeyRef.current !== targetReview.pr.key) return;
      const text = `Focus review failed: ${err instanceof Error ? err.message : String(err)}`;
      setFocusReview((current) => ({ ...current, open: !background || current.open, running: false, text, activity: null }));
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

  async function loadReviewMemory() {
    setMemoryLoading(true);
    try {
      const data = await api<ReviewMemoryResponse>("/api/review-memory?limit=80");
      setReviewMemory(data);
      return data;
    } finally {
      setMemoryLoading(false);
    }
  }

  async function showReviewMemory() {
    setMemoryOpen(true);
    await loadReviewMemory();
  }

  async function distillReviewMemory() {
    setMemoryDistilling(true);
    try {
      await api<{ profile: string }>("/api/review-memory/distill", { method: "POST", body: JSON.stringify({}) });
      await loadReviewMemory();
    } finally {
      setMemoryDistilling(false);
    }
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
    navigateHash(homeHash);
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

  return <main className="app-shell"><header className="toolbar"><div className="toolbar-title"><strong>Pi PR Review</strong><span>{review == null ? "Paste a PR to start" : `${review.pr.key} · ${review.pr.title}`}</span></div><div className="toolbar-actions">{review != null && <><a className="toolbar-link" href={homeHash} onClick={(event) => { if (!isPlainLeftClick(event)) return; event.preventDefault(); goHome(); }}>Home</a><button type="button" className="toolbar-icon" title="Pi session settings" aria-label="Pi session settings" onClick={() => { setSettingsOpen(true); void loadDiagnostics(); }}>⚙</button><button type="button" className="toolbar-icon" title="Pi session diagnostics" aria-label="Pi session diagnostics" onClick={() => void showDiagnostics()}>🐞</button><button type="button" title="Open GPU workspace" onClick={() => setGpuWorkspaceOpen(true)}>GPU</button><button type="button" className="toolbar-codewalk" title="Code walk" onClick={() => { setFlowDagOpen(true); if (flowDag.text.trim().length === 0 && !flowDag.running) void runFlowDag(); }}><span>Code walk</span>{flowDag.running && <span className="spinner" aria-hidden="true" />}</button></>}<button type="button" className="toolbar-icon" title="Review memory" aria-label="Review memory" onClick={() => void showReviewMemory()}>🧠</button><button type="button" className="toolbar-icon" title="Server log" aria-label="Server log" onClick={() => { setLogsOpen(true); void refreshLogs(); }}>📜</button><select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeName)}>{themes.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}</select>{review != null && <form className="open-form" onSubmit={submit}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="OWNER/REPO#123 or GitHub PR URL" /><button disabled={busy || input.trim().length === 0}>{busy ? "Fetching…" : "Open"}</button></form>}</div></header>{error != null && <div className="error">{error}</div>}{busy && review == null ? <div className="loading-page"><svg className="loading-cog" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20a1 1 0 0 1-1-1v-1.07A7.002 7.002 0 0 1 5.07 12H4a1 1 0 1 1 0-2h1.07A7.002 7.002 0 0 1 11 4.07V3a1 1 0 1 1 2 0v1.07A7.002 7.002 0 0 1 18.93 10H20a1 1 0 1 1 0 2h-1.07A7.002 7.002 0 0 1 13 18.93V20a1 1 0 0 1-1 1Z" /><circle cx="12" cy="12" r="3" /></svg><p>Loading pull request…</p></div> : review == null ? <StartPage prs={prs} openPr={openPr} cleanupPr={cleanupPr} openInput={input} setOpenInput={setInput} busy={busy} /> : <ReviewPage review={review} openFiles={openFiles} setOpenFiles={setOpenFiles} diffViewMode={diffViewMode} setDiffViewMode={setDiffViewMode} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} threads={threads} setThreads={setThreads} toggleThread={toggleThread} setViewed={setViewed} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} sideWidth={sideWidth} setSideWidth={setSideWidth} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} commentCollapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} toggleAllComments={toggleAllComments} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} piPanel={{ review: aiReview, aiReviewHistory: review.aiReviews, aiReviewId, showAiReviewRecord, runReview: runAiReview, sendMessage: sendAiReviewMessage, chatSending: aiChatSending, clearFollowUp: clearAiReviewFollowUp, copyFeedbackPrompt: copyReviewFeedbackPrompt, focusReview, focusScanHistory: review.focusScans, focusScanId, showFocusScanRecord, runFocusReview, viewedFocusIds: viewedFocusAreaIds, setViewedFocusIds: setViewedFocusAreaIds, saveFocusScan }} reviewEvent={reviewEvent} setReviewEvent={setReviewEvent} reviewBody={reviewBody} setReviewBody={setReviewBody} submitReview={submitReview} submitting={submitting} invalidDraftIds={invalidDraftIds} refreshGithubActivity={refreshGithubActivity} refreshingActivity={refreshingActivity} theme={theme} setTheme={setTheme} />}{diagnostics != null && !settingsOpen && <DiagnosticsModal diagnostics={diagnostics} aiReview={aiReview} focusReview={focusReview} focusAreaCount={focusAreas.length} refresh={loadDiagnostics} close={() => setDiagnostics(null)} />}{review != null && settingsOpen && <PiSettingsModal prKey={review.pr.key} diagnostics={diagnostics} setDiagnostics={setDiagnostics} openDiagnostics={() => { setSettingsOpen(false); void showDiagnostics(); }} close={() => setSettingsOpen(false)} />}{memoryOpen && <ReviewMemoryModal memory={reviewMemory} loading={memoryLoading} distilling={memoryDistilling} refresh={() => void loadReviewMemory()} distill={() => void distillReviewMemory()} close={() => setMemoryOpen(false)} />}{review != null && gpuWorkspaceOpen && <GpuWorkspaceModal review={review} close={() => setGpuWorkspaceOpen(false)} refreshLogs={refreshLogs} />}{review != null && flowDagOpen && <FlowDagModal flowDag={flowDag} runFlowDag={runFlowDag} close={() => setFlowDagOpen(false)} prUrl={review.pr.url} headSha={review.pr.headSha} />}{logsOpen && <LogsModal logs={logs} refreshLogs={refreshLogs} close={() => setLogsOpen(false)} />}</main>;
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
    <a className="pr-card-body" href={reviewHash(pr.url)} onClick={(event) => { if (!isPlainLeftClick(event)) return; event.preventDefault(); void openPr(pr.url); }}>
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
    </a>
    <button className="trash-button" title="Remove saved PR and cleanup worktree" onClick={() => void cleanupPr(pr)}>🗑</button>
  </article>;
}

function runningAgentActivity(purpose: string, label = "starting agent"): PiAgentActivity {
  const now = new Date().toISOString();
  return { purpose, status: "running", label, elapsedMs: 0, idleMs: 0, chars: 0, answerChars: 0, activeTools: [], isStreaming: null, queued: false, startedAt: now, lastActivityAt: now };
}

function streamingAgentActivity(current: PiAgentActivity | null | undefined, answer: string): PiAgentActivity {
  const now = new Date().toISOString();
  return { ...(current ?? runningAgentActivity("chat")), status: "running", label: answer.length > 0 ? "streaming response" : "thinking", answerChars: answer.length, lastActivityAt: now };
}

function diagnosticsAgentActivity(session: Record<string, unknown>, fallback: PiAgentActivity | null): PiAgentActivity | null {
  const state = session.promptState as Record<string, unknown> | null | undefined;
  if (state == null) return fallback;
  const activeTools = Array.isArray(session.activeTools) ? session.activeTools.filter((tool): tool is string => typeof tool === "string") : [];
  const status = typeof state.status === "string" ? state.status as PiAgentActivity["status"] : "running";
  const label = activeTools.length > 0 ? `using ${activeTools.join(", ")}` : status === "queued" ? "queued" : session.isStreaming === true ? "streaming response" : "thinking";
  return {
    purpose: typeof session.purpose === "string" ? session.purpose : fallback?.purpose ?? "chat",
    status,
    label,
    elapsedMs: typeof state.elapsedMs === "number" ? state.elapsedMs : fallback?.elapsedMs ?? 0,
    idleMs: typeof state.lastActivityAt === "string" ? Date.now() - Date.parse(state.lastActivityAt) : fallback?.idleMs ?? 0,
    chars: typeof state.chars === "number" ? state.chars : fallback?.chars ?? 0,
    answerChars: typeof state.answerChars === "number" ? state.answerChars : fallback?.answerChars ?? 0,
    activeTools,
    isStreaming: typeof session.isStreaming === "boolean" ? session.isStreaming : fallback?.isStreaming ?? null,
    queued: session.queued === true || status === "queued",
    startedAt: typeof state.startedAt === "string" ? state.startedAt : fallback?.startedAt,
    lastActivityAt: typeof state.lastActivityAt === "string" ? state.lastActivityAt : fallback?.lastActivityAt,
    error: typeof state.error === "string" ? state.error : fallback?.error,
    detail: typeof state.detail === "string" ? state.detail : fallback?.detail,
  };
}

function compactDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function agentActivityTone(activity: PiAgentActivity | null | undefined): "working" | "quiet" | "stale" {
  const idleMs = activity?.idleMs ?? 0;
  if (idleMs > 120_000) return "stale";
  if (idleMs > 45_000) return "quiet";
  return "working";
}

function agentActivityText(activity: PiAgentActivity | null | undefined): string {
  if (activity == null) return "Starting agent…";
  const parts = [activity.label, `${compactDuration(activity.elapsedMs)} elapsed`];
  if (activity.idleMs != null) parts.push(`${compactDuration(activity.idleMs)} quiet`);
  if (activity.answerChars > 0) parts.push(`${activity.answerChars.toLocaleString()} chars`);
  return parts.join(" · ");
}

function maxSidePanelWidth(): number {
  return typeof window === "undefined" ? 900 : Math.max(380, window.innerWidth - 96);
}

function clampSidePanelWidth(width: number): number {
  return Math.min(maxSidePanelWidth(), Math.max(300, width));
}

function ReviewPage(props: DiffProps & { piPanel: PiPanelProps; reviewEvent: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; setReviewEvent: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES") => void; reviewBody: string; setReviewBody: (body: string) => void; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<boolean>; submitting: boolean; invalidDraftIds: Record<string, boolean>; refreshingActivity: boolean; theme: ThemeName; setTheme: (theme: ThemeName) => void }) {
  const commentToggleLabel = props.commentsCollapsed ? "Expand all comments" : "Collapse all comments";
  const diffViewLabel = props.diffViewMode === "unified" ? "Split view" : "Unified view";
  const [sideTab, setSideTab] = useState<"review" | "pi" | "comments">("review");
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const restoreSideWidthRef = useRef<number | null>(null);
  const maxWidth = maxSidePanelWidth();
  const sideMaximized = props.sideWidth >= maxWidth - 24;
  function toggleSideMaximized(): void {
    if (sideMaximized) {
      props.setSideWidth(clampSidePanelWidth(restoreSideWidthRef.current ?? 420));
      restoreSideWidthRef.current = null;
      return;
    }
    restoreSideWidthRef.current = props.sideWidth;
    props.setSideWidth(maxWidth);
  }
  const draftCount = props.drafts.length;
  const piActivity = props.piPanel.review.messages.length + (props.piPanel.review.text.length > 0 && props.piPanel.review.messages.length === 0 ? 1 : 0);
  const focusCount = props.focusAreas.length;
  const piBadge = focusCount > 0 ? focusCount : piActivity > 0 ? piActivity : null;
  const commentCount = props.review.comments.length + props.review.issueComments.length + props.review.reviewSummaries.length;
  const annotations = useMemo(() => buildDiffAnnotationIndex(props.review.comments, props.drafts, props.threads, props.focusAreas), [props.review.comments, props.drafts, props.threads, props.focusAreas]);
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
  const sidePanel = sideCollapsed ? null : <>
    <div className="resize-handle" role="separator" aria-label="Resize side panel" onMouseDown={(event) => startResizeSidePanel(event, props.sideWidth, props.setSideWidth)} />
    <aside className={`side${sideMaximized ? " maximized" : ""}`}>
      <nav className="side-tabs" role="tablist" aria-label="Review side panel">
        <button role="tab" aria-selected={sideTab === "review"} className={`side-tab${sideTab === "review" ? " active" : ""}`} onClick={() => setSideTab("review")}><span className="side-tab-pie" aria-hidden="true">🥧</span><span>Review</span>{draftCount > 0 && <span className="side-tab-badge">{draftCount}</span>}</button>
        <button role="tab" aria-selected={sideTab === "pi"} className={`side-tab${sideTab === "pi" ? " active" : ""}`} onClick={() => setSideTab("pi")}><span className="side-tab-pie" aria-hidden="true">π</span><span>Pi</span>{piBadge != null && <span className="side-tab-badge">{piBadge}</span>}</button>
        <button role="tab" aria-selected={sideTab === "comments"} className={`side-tab${sideTab === "comments" ? " active" : ""}`} onClick={() => setSideTab("comments")}><span className="side-tab-pie" aria-hidden="true">💬</span><span>Comments</span>{commentCount > 0 && <span className="side-tab-badge">{commentCount}</span>}</button>
        <button type="button" className="side-maximize-button" title={sideMaximized ? "Restore side panel" : "Maximize side panel"} aria-label={sideMaximized ? "Restore side panel" : "Maximize side panel"} onClick={toggleSideMaximized}>{sideMaximized ? "⇥" : "⇤"}</button>
        <button type="button" className="side-maximize-button" title="Hide review panel" aria-label="Hide review panel" onClick={() => setSideCollapsed(true)}><ChevronRightIcon size={16} /></button>
      </nav>
      <div className="side-tab-panels">
        {sideTab === "review" && <ReviewSummary pr={props.review.pr} files={props.review.files} drafts={props.drafts} setDrafts={props.setDrafts} event={props.reviewEvent} setEvent={props.setReviewEvent} body={props.reviewBody} setBody={props.setReviewBody} editingDraftId={props.editingDraftId} setEditingDraftId={props.setEditingDraftId} submitReview={props.submitReview} submitting={props.submitting} invalidDraftIds={props.invalidDraftIds} copyFeedbackPrompt={props.piPanel.copyFeedbackPrompt} onJumpToDraft={(draft) => jumpToComment({ ...draft, hunk: "" })} />}
        {sideTab === "pi" && <InlineSnippetsProvider value={{ headSha: props.review.pr.headSha, snippets: true }}><AiReviewPanel prUrl={props.review.pr.url} {...props.piPanel} focusAreas={props.focusAreas} setActiveFocusAreaId={props.setActiveFocusAreaId} collapsedFocusAreaIds={props.collapsedFocusAreaIds} setCollapsedFocusAreaIds={props.setCollapsedFocusAreaIds} openFiles={props.openFiles} setOpenFiles={props.setOpenFiles} /></InlineSnippetsProvider>}
        {sideTab === "comments" && <ExistingComments prUrl={props.review.pr.url} comments={props.review.comments} issueComments={props.review.issueComments} reviewSummaries={props.review.reviewSummaries} refreshGithubActivity={props.refreshGithubActivity} collapseSignal={props.commentCollapseSignal} commentsCollapsed={props.commentsCollapsed} toggleAllComments={props.toggleAllComments} onJumpToComment={jumpToComment} />}
      </div>
    </aside>
  </>;
  const gridTemplateColumns = sideCollapsed ? "minmax(0, 1fr)" : sideMaximized ? `0 0 minmax(0, ${props.sideWidth}px)` : `minmax(0, 1fr) 12px ${props.sideWidth}px`;
  return <div className={`review-layout${sideCollapsed ? " side-collapsed" : ""}`} style={{ gridTemplateColumns }}>
    <main className="files">
      <PrHeaderStrip pr={props.review.pr} refreshGithubActivity={props.refreshGithubActivity} refreshingActivity={props.refreshingActivity} />
      <PrSummary pr={props.review.pr} />
      <div className="files-toolbar">
        <FileNavigator files={props.review.files} fileReviews={props.review.fileReviews} openFiles={props.openFiles} setOpenFiles={props.setOpenFiles} />
        <div className="files-toolbar-actions">
          <div className="theme-buttons">
            {themes.map((item) => <button key={item.name} className={`small-muted-button${props.theme === item.name ? " active" : ""}`} type="button" title={item.label} aria-pressed={props.theme === item.name} onClick={() => props.setTheme(item.name)}>{item.shortLabel}</button>)}
          </div>
          <button className="small-muted-button" onClick={() => props.setDiffViewMode(props.diffViewMode === "unified" ? "split" : "unified")}>{diffViewLabel}</button>
          <button className="small-muted-button" onClick={props.toggleAllComments}>{commentToggleLabel}</button>
          <button className="small-muted-button" onClick={() => setSideCollapsed((collapsed) => !collapsed)}>{sideCollapsed ? "Show review panel" : "Hide review panel"}</button>
        </div>
      </div>
      <DiffAnnotationsContext.Provider value={annotations}>{props.review.files.map((file) => <FileDiff key={file.filename} file={file} {...props} />)}</DiffAnnotationsContext.Provider>
    </main>
    {sidePanel}
    {draftCount > 0 && (sideCollapsed || sideTab !== "review") && <Button className="floating-submit" onClick={() => { setSideCollapsed(false); setSideTab("review"); }}>Review draft ({draftCount}) →</Button>}
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
    setOpen(false);
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
            {file.generated && <span className="generated-badge">Generated</span>}
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
    const nextWidth = clampSidePanelWidth(initialWidth - (moveEvent.clientX - startX));
    setSideWidth(nextWidth);
  }
  function stop() {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", stop);
  }
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
}

function rowHasKind(row: DiffRow, kind: string): boolean {
  return row.kind.split(" ").includes(kind);
}

function rowTargetLine(row: DiffRow): number | null {
  return row.targetLine ?? row.newLine ?? row.oldLine;
}

function rowTargetSide(row: DiffRow): "RIGHT" | "LEFT" {
  return row.targetSide ?? (row.newLine != null ? "RIGHT" : "LEFT");
}

function targetIsRendered(rows: DiffRow[], target: Target): boolean {
  return rows.some((row) => target.line != null && target.side === rowTargetSide(row) && target.line === rowTargetLine(row));
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
  return rows.some((row) => (row.targetLine ?? row.newLine) === area.startLine);
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
  const annotations = useContext(DiffAnnotationsContext);
  const rows = useMemo(() => parsePatchRows(file.patch), [file.patch]);
  const patchSetSections = useMemo(() => parsePatchSetSections(file.patch), [file.patch]);
  const fileReview = review.fileReviews.find((state) => state.path === file.filename);
  const open = openFiles[file.filename] ?? true;
  const reviewCommentThreads = annotations.commentThreadsByFile.get(file.filename) ?? [];
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
  const diffBody = patchSetSections.length > 0
    ? <PatchSetRows file={file} sections={patchSetSections} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />
    : rows.length === 0
      ? <DiffRowView row={{ kind: "meta", oldLine: null, newLine: null, text: "Patch unavailable. Click to attach a file-level note.", hunk: "" }} target={{ path: file.filename, line: null, side: "RIGHT", hunk: "" }} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={review.comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />
      : <FoldedRows file={file} rows={rows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} expandedContext={expandedContext} setExpandedContext={setExpandedContext} expandedNeighborRows={expandedNeighborRows} expandNeighbor={expandNeighbor} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />;
  return <section className="file" id={`file-${file.filename}`}><div className="file-summary"><button className="file-summary-left" onClick={() => setOpenFiles({ ...openFiles, [file.filename]: !open })}><span className="collapse-chevron">{open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}</span><span className="file-change-count">{file.changes.toLocaleString()}</span><span className="file-diffstat" aria-label={`${file.additions} additions and ${file.deletions} deletions`}><span className="file-diffstat-add" style={{ flexGrow: file.additions }} /><span className="file-diffstat-del" style={{ flexGrow: file.deletions }} /></span><strong className="file-path">{file.filename}</strong>{file.generated && <span className="generated-badge">Generated</span>}</button><label className="viewed-toggle" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={fileReview?.viewed ?? false} onChange={(event) => void setViewed(file, event.target.checked)} /> Viewed</label></div>{open && <><div className="patch">{diffBody}{commentAnchorRows.length > 0 && <CommentAnchorRows file={file} rows={commentAnchorRows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />}{focusAnchorRows.length > 0 && <FocusAnchorRows file={file} rows={focusAnchorRows} comments={review.comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />}{unrenderedCommentThreads.length > 0 && <UnrenderedCommentThreads threads={unrenderedCommentThreads} prUrl={review.pr.url} refreshGithubActivity={refreshGithubActivity} collapseSignal={commentCollapseSignal} commentsCollapsed={commentsCollapsed} />}</div></>}</section>;
}

function patchSetSectionKey(file: PullFile, title: string, firstLine: number | null | undefined): string {
  return `${file.filename}:${title}:${firstLine ?? ""}`;
}

function PatchSetRows({ file, sections, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { file: PullFile; sections: ReturnType<typeof parsePatchSetSections>; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  return <div className="patchset-renderer">{sections.map((section) => {
    const sectionKey = patchSetSectionKey(file, section.title, section.rows[0]?.newLine);
    const collapsed = collapsedSections[sectionKey] ?? false;
    return <div className={`patchset-section${collapsed ? " collapsed" : ""}`} key={sectionKey}><button className="patchset-section-title" aria-expanded={!collapsed} onClick={() => setCollapsedSections((current) => ({ ...current, [sectionKey]: !collapsed }))}><span className="patchset-title-left"><span className="collapse-chevron">{collapsed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</span>{section.title}</span><span>{section.rows.length} lines</span></button>{!collapsed && section.rows.map((row, index) => <ConnectedRow key={`${file.filename}:patchset:${section.title}:${index}`} file={file} row={row} languagePath={section.path} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />)}</div>;
  })}</div>;
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
      rendered.push(<button className="expand-row" key={`${aboveKey}:button`} aria-label="Expand lines above" title="Expand lines above" onClick={() => void expandNeighbor(file, aboveKey, Math.max(1, start - (expandedNeighborRows[aboveKey]?.length ?? 0) - 10), start - 1)}><ChevronUpIcon size={16} /></button>);
      (expandedNeighborRows[aboveKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${aboveKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />));
    }

    block.forEach((row, offset) => rendered.push(<ConnectedRow key={`${file.filename}:${index + offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />));

    if (lastLine != null) {
      const belowKey = `${file.filename}:${index}:below`;
      (expandedNeighborRows[belowKey] ?? []).forEach((row, offset) => rendered.push(<ConnectedRow key={`${belowKey}:${offset}`} file={file} row={row} comments={comments} threads={threads} setThreads={setThreads} toggleThread={toggleThread} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />));
      rendered.push(<button className="expand-row" key={`${belowKey}:button`} aria-label="Expand lines below" title="Expand lines below" onClick={() => void expandNeighbor(file, belowKey, lastLine + 1, lastLine + (expandedNeighborRows[belowKey]?.length ?? 0) + 10)}><ChevronDownIcon size={16} /></button>);
    }
    index = blockEnd - 1;
  }
  return <>{rendered}</>;
}

function ConnectedRow({ file, row, languagePath, comments, threads, setThreads, toggleThread, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { file: PullFile; row: DiffRow; languagePath?: string; comments: PullReviewComment[]; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  const line = rowTargetLine(row);
  const target = line == null || rowHasKind(row, "hunk") || rowHasKind(row, "meta") ? null : { path: file.filename, line, side: rowTargetSide(row), hunk: row.hunk };
  return <DiffRowView row={row} target={target} languagePath={languagePath} threads={threads} setThreads={setThreads} toggleThread={toggleThread} comments={comments} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} askThread={askThread} askFocusArea={askFocusArea} dragSelection={dragSelection} beginDrag={beginDrag} updateDrag={updateDrag} finishDrag={finishDrag} handleRowClick={handleRowClick} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} commentsCollapsed={commentsCollapsed} diffViewMode={diffViewMode} focusAreas={focusAreas} activeFocusAreaId={activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} />;
}

function updateDraft(drafts: DraftComment[], setDrafts: (drafts: DraftComment[]) => void, id: string, body: string): void {
  setDrafts(drafts.map((draft) => draft.id === id ? { ...draft, body } : draft));
}

function diffMarker(row: DiffRow): string {
  if (rowHasKind(row, "added")) return "+";
  if (rowHasKind(row, "removed")) return "-";
  return " ";
}

function diffCodeText(row: DiffRow): string {
  return rowHasKind(row, "hunk") || rowHasKind(row, "meta") ? row.text : row.text.replace(/^[+\- ]/, "");
}

function isDiffCodeSelection(event: React.MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && event.target.closest(".code-cell code") != null;
}

function hasSelectedDiffCode(event: React.MouseEvent<HTMLElement>): boolean {
  return isDiffCodeSelection(event) && (window.getSelection()?.toString().length ?? 0) > 0;
}

function DraftView({ draft, index, invalid = false, drafts, setDrafts, editingDraftId, setEditingDraftId, onJump }: { draft: DraftComment; index?: number; invalid?: boolean; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; onJump?: () => void }) {
  const editing = editingDraftId === draft.id;
  const [removing, setRemoving] = useState(false);
  function removeDraft(): void {
    if (removing) return;
    setRemoving(true);
    window.setTimeout(() => setDrafts(drafts.filter((item) => item.id !== draft.id)), 160);
  }
  return <div className={`draft-card${editing ? " editing" : ""}${removing ? " removing" : ""}${invalid ? " invalid" : ""}`}>
    <div className="draft-card-head">
      <div className={`draft-card-location${onJump != null ? " clickable" : ""}`} onClick={onJump} role={onJump != null ? "button" : undefined} tabIndex={onJump != null ? 0 : undefined}>
        {index != null && <span className="draft-card-index">#{index + 1}</span>}
        <strong>{targetLabel(draft)}</strong>
        {invalid && <span className="draft-card-warning">needs re-anchor</span>}
      </div>
      <div className="draft-card-actions">
        <Button variant="icon" aria-label={editing ? "Done editing" : "Edit draft"} onClick={() => setEditingDraftId(editing ? null : draft.id)}>{editing ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}</Button>
        <Button variant="icon" className="close-thread-button" aria-label="Remove draft" onClick={removeDraft} disabled={removing}><XIcon size={14} /></Button>
      </div>
    </div>
    <div className="draft-card-body">{editing ? <textarea autoFocus rows={1} value={draft.body} onChange={(event) => updateDraft(drafts, setDrafts, draft.id, event.target.value)} onInput={(event) => autoGrowTextarea(event.currentTarget)} ref={(element) => autoGrowTextarea(element)} /> : <p>{draft.body}</p>}</div>
  </div>;
}

function DiffRowView({ row, target, languagePath, threads, setThreads, toggleThread, comments, drafts, setDrafts, editingDraftId, setEditingDraftId, askThread, askFocusArea, dragSelection, beginDrag, updateDrag, finishDrag, handleRowClick, prUrl, refreshGithubActivity, collapseSignal, commentsCollapsed, diffViewMode, focusAreas, activeFocusAreaId, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds }: { row: DiffRow; target: Target | null; languagePath?: string; threads: Record<string, Thread>; setThreads: DiffProps["setThreads"]; toggleThread: (target: Target, extend?: boolean) => void; comments: PullReviewComment[]; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; askThread: (thread: Thread) => Promise<void>; askFocusArea: (area: FocusArea, question: string) => Promise<string>; dragSelection: DragSelection | null; beginDrag: (target: Target) => void; updateDrag: (target: Target) => void; finishDrag: (target: Target) => void; handleRowClick: (target: Target, extend: boolean) => void; prUrl: string; refreshGithubActivity: () => Promise<void>; collapseSignal: number; commentsCollapsed: boolean; diffViewMode: DiffViewMode; focusAreas: FocusArea[]; activeFocusAreaId: string | null; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"] }) {
  const annotations = useContext(DiffAnnotationsContext);
  const annotationKey = target == null ? null : diffAnnotationTargetKey(target);
  const thread = annotationKey == null ? null : annotations.threadsByTarget.get(annotationKey) ?? null;
  const inlineCommentThreads = annotationKey == null ? [] : annotations.commentThreadsByTarget.get(annotationKey) ?? [];
  const inlineDrafts = annotationKey == null ? [] : annotations.draftsByTarget.get(annotationKey) ?? [];
  const selecting = isTargetInSelection(target, dragSelection);
  const inThreadRange = annotationKey != null && annotations.openThreadRangeTargets.has(annotationKey);
  const rowFocusAreas = annotationKey == null ? [] : annotations.focusAreasByTarget.get(annotationKey) ?? [];
  const language = rowHasKind(row, "hunk") || rowHasKind(row, "meta") ? "" : languageForPath(languagePath ?? target?.path);
  const hasThreadPill = thread != null || inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length > 0;
  const threadPill = hasThreadPill ? <span className="pill">{(thread == null ? 0 : 1) + inlineCommentThreads.length + inlineDrafts.length + rowFocusAreas.length}</span> : null;
  const codeText = diffCodeText(row);
  const showMarker = !(rowHasKind(row, "hunk") || rowHasKind(row, "meta"));
  const codeCell = (className = "code-cell") => <span className={className}>{showMarker && <span className="diff-marker">{diffMarker(row)}</span>}<CodeText code={codeText} language={language} syntaxContext={row.syntaxContext} /></span>;
  const unifiedCells = <><span className="num old-num">{row.oldLine ?? ""}</span><span className="num new-num">{row.newLine ?? ""}</span>{codeCell()}{threadPill}</>;
  const splitCells = <><span className="num old-num">{row.oldLine ?? ""}</span><div className="split-code old-code">{row.newLine == null || rowHasKind(row, "context") || rowHasKind(row, "hunk") || rowHasKind(row, "meta") ? codeCell("code-cell split-code-cell") : null}</div><span className="num new-num">{row.newLine ?? ""}</span><div className="split-code new-code">{row.oldLine == null || rowHasKind(row, "context") || rowHasKind(row, "hunk") || rowHasKind(row, "meta") ? codeCell("code-cell split-code-cell") : null}</div>{threadPill}</>;
  return <><div className={`diff-row ${diffViewMode} ${row.kind} ${thread != null && !thread.collapsed ? "selected" : ""} ${selecting ? "range-selecting" : ""} ${inThreadRange ? "in-thread-range" : ""}`} data-path={target?.path} data-line={target?.line ?? undefined} data-side={target?.side} data-hunk={target?.hunk} onMouseDown={(event) => { if (target != null && event.button === 0) { if (isDiffCodeSelection(event)) return; event.preventDefault(); beginDrag(target); } }} onMouseEnter={() => { if (target != null && dragSelection != null) updateDrag(target); }} onMouseUp={() => { if (target != null) finishDrag(target); }} onClick={(event) => { if (target != null && !hasSelectedDiffCode(event)) handleRowClick(target, event.shiftKey); }}>{diffViewMode === "split" ? splitCells : unifiedCells}</div>{inlineCommentThreads.map((commentThread) => <ExistingReviewThread key={commentThread.map((comment) => comment.id).join(":")} comments={commentThread} prUrl={prUrl} refreshGithubActivity={refreshGithubActivity} collapseSignal={collapseSignal} collapseComments={commentsCollapsed} />)}{rowFocusAreas.map((area) => <FocusAreaInline key={area.id} prUrl={prUrl} area={area} active={area.id === activeFocusAreaId} setActiveFocusAreaId={setActiveFocusAreaId} collapsedFocusAreaIds={collapsedFocusAreaIds} setCollapsedFocusAreaIds={setCollapsedFocusAreaIds} askFocusArea={askFocusArea} addDraft={(body) => setDrafts([...drafts, { id: newId(), path: area.path, line: area.endLine, startLine: area.startLine, side: "RIGHT", body }])} />)}{inlineDrafts.map((draft) => <div className="inline-thread draft" key={draft.id}><DraftView draft={draft} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} /></div>)}{thread != null && <ThreadBox prUrl={prUrl} thread={thread} setThread={(updatedThread) => setThreads((current) => { const next = { ...current }; delete next[thread.key]; next[updatedThread.key] = updatedThread; return next; })} closeThread={() => setThreads((current) => { const next = { ...current }; delete next[thread.key]; return next; })} addDraft={() => { if (thread.draft.trim().length > 0) setDrafts([...drafts, { id: newId(), path: thread.target.path, line: thread.target.line, startLine: thread.target.startLine, side: thread.target.side, body: thread.draft.trim() }]); setThreads((current) => { const next = { ...current }; if (thread.messages.length === 0) delete next[thread.key]; else next[thread.key] = { ...thread, draft: "", collapsed: true }; return next; }); }} askThread={askThread} />}</>;
}

function FocusAreaInline({ prUrl, area, active, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds, askFocusArea, addDraft }: { prUrl: string; area: FocusArea; active: boolean; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"]; askFocusArea: DiffProps["askFocusArea"]; addDraft: (body: string) => void }) {
  const collapsed = collapsedFocusAreaIds[area.id] ?? false;
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [activity, setActivity] = useState<PiAgentActivity | null>(null);
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
    setActivity(runningAgentActivity("focus-chat"));
    setMessages((current) => [...current, { role: "user", text: question }, { role: "pi", text: "" }]);
    try {
      const setAnswer = (answer: string) => {
        setActivity((current) => streamingAgentActivity(current, answer));
        setMessages((current) => [...current.slice(0, -1), { role: "pi", text: answer }]);
      };
      const answer = await askFocusArea(area, question, setAnswer, setActivity);
      setMessages((current) => [...current.slice(0, -1), { role: "pi", text: answer }]);
    } catch (err) {
      setMessages((current) => [...current.slice(0, -1), { role: "pi", text: `Ask Pi failed: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setAsking(false);
      setActivity(null);
    }
  }
  if (collapsed) return <div id={`focus-area-${area.id}`} className="inline-thread review-thread focus-area-inline focus-area-minimized focus-area-collapsed minimized" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: false }))}><div className="thread-head"><div className="thread-title"><Button variant="icon" aria-label="Expand focus area" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: false }))}><ChevronRightIcon size={16} /></Button><div><strong>Focus area</strong><span>{area.title}</span></div></div></div></div>;
  return <div id={`focus-area-${area.id}`} className={`inline-thread review-thread focus-area-inline${active ? " active" : ""}`}><div className="thread-head"><div className="thread-title"><strong>Focus area</strong><span>{area.path}:{area.startLine === area.endLine ? area.startLine : `${area.startLine}-${area.endLine}`}</span></div><div className="actions"><Button variant="icon" aria-label="Collapse focus area" onClick={() => setCollapsedFocusAreaIds((current) => ({ ...current, [area.id]: true }))}><ChevronDownIcon size={16} /></Button></div></div><div className="thread-messages"><div className="thread-note pi"><div className="message-role">Pi focus</div><MarkdownText text={area.body} fileLinks={{ prUrl }} /></div>{messages.map((message, index) => <div className={`thread-note ${message.role}`} key={index}><div className="message-role">{message.role === "user" ? "You" : "Pi"}</div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div>)}</div><div className="composer"><textarea rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onInput={(event) => autoGrowTextarea(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void ask(); } }} placeholder="Ask Pi or write a draft comment about this focus area" />{asking && <AgentActivityLine activity={activity} />}<div className="actions"><button onClick={() => void ask()} disabled={asking || draft.trim().length === 0}>{asking ? "Asking" : "Ask Pi"}</button><button className="composer-primary" onClick={saveDraftComment} disabled={draft.trim().length === 0}>Add draft comment</button></div></div></div>;
}

function ThreadMessageTimeline({ prUrl, messages }: { prUrl: string; messages: ThreadMessage[] }) {
  return <div className="local-comment-timeline">{messages.map((message, index) => <div className={`local-comment ${message.role}`} key={index}><div className="avatar" aria-hidden="true">{message.role === "user" ? "Y" : "π"}</div><div className="github-comment-body"><div className="github-comment-header"><strong>{message.role === "user" ? "You" : "Pi"}</strong></div><MarkdownText text={message.text} fileLinks={{ prUrl }} /></div></div>)}</div>;
}

function ThreadBox({ prUrl, thread, setThread, closeThread, addDraft, askThread }: { prUrl: string; thread: Thread; setThread: (thread: Thread) => void; closeThread: () => void; addDraft: () => void; askThread: (thread: Thread) => Promise<void> }) {
  if (thread.collapsed) return <button className="inline-thread collapsed" onClick={() => setThread({ ...thread, collapsed: false })}><ChevronRightIcon size={14} /><span className="collapsed-pill-label">{thread.target.line == null ? "Draft thread on file" : targetLabel(thread.target)}</span></button>;
  return <div className="inline-thread review-thread local-thread" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeThread(); } }}><div className="thread-head"><div className="thread-title"><strong>Line thread</strong><span>{targetLabel(thread.target)}</span></div><div className="actions">{(thread.draft.trim().length > 0 || thread.messages.length > 0) && <Button variant="icon" aria-label="Collapse thread" onClick={() => setThread({ ...thread, collapsed: true })}><ChevronDownIcon size={16} /></Button>}<Button variant="icon" className="close-thread-button" aria-label="Close thread" onClick={closeThread}><XIcon size={16} /></Button></div></div>{thread.messages.length > 0 && <ThreadMessageTimeline prUrl={prUrl} messages={thread.messages} />}<div className="composer"><textarea rows={1} value={thread.draft} onChange={(event) => setThread({ ...thread, draft: event.target.value })} onInput={(event) => autoGrowTextarea(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && thread.draft.trim().length > 0 && !thread.asking) { event.preventDefault(); void askThread(thread); } }} placeholder="Write a draft comment or ask Pi about this line" />{thread.asking && <AgentActivityLine activity={thread.activity} />}<div className="actions"><button onClick={() => void askThread(thread)} disabled={thread.asking || thread.draft.trim().length === 0}>{thread.asking ? "Asking" : "Ask Pi"}</button><button className="composer-primary" onClick={addDraft} disabled={thread.draft.trim().length === 0}>Add draft comment</button></div></div></div>;
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

function ReviewSummary({ pr, files, drafts, setDrafts, event, setEvent, body, setBody, editingDraftId, setEditingDraftId, submitReview, submitting, invalidDraftIds, copyFeedbackPrompt, onJumpToDraft }: { pr: StoredPullRequest; files: PullFile[]; drafts: DraftComment[]; setDrafts: (drafts: DraftComment[]) => void; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; setEvent: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES") => void; body: string; setBody: (body: string) => void; editingDraftId: string | null; setEditingDraftId: (id: string | null) => void; submitReview: (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string) => Promise<boolean>; submitting: boolean; invalidDraftIds: Record<string, boolean>; copyFeedbackPrompt: (overallBody?: string) => Promise<void>; onJumpToDraft?: (draft: DraftComment) => void }) {
  const [submitted, setSubmitted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyingFeedback, setCopyingFeedback] = useState(false);
  const [feedbackCopied, setFeedbackCopied] = useState(false);
  const [feedbackCopyError, setFeedbackCopyError] = useState<string | null>(null);
  const hasDrafts = drafts.length > 0;
  const hasReviewContent = body.trim().length > 0 || hasDrafts;
  const [composing, setComposing] = useState(hasReviewContent);
  const showSubmitted = submitted && !hasReviewContent;
  useEffect(() => {
    if (hasDrafts) setComposing(true);
  }, [hasDrafts]);
  async function handleSubmit() {
    if (submitting || !hasReviewContent) return;
    if (await submitReview(event, body)) {
      setBody("");
      setEvent("COMMENT");
      setSubmitted(true);
      setComposing(false);
    }
  }
  async function copyDraftContext() {
    if (!hasReviewContent) return;
    await writeClipboard(reviewDraftContext(pr, files, body, drafts));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  async function copyFeedback() {
    if (copyingFeedback) return;
    setCopyingFeedback(true);
    setFeedbackCopyError(null);
    try {
      await copyFeedbackPrompt(body);
      setFeedbackCopied(true);
      window.setTimeout(() => setFeedbackCopied(false), 1600);
    } catch (err) {
      setFeedbackCopyError(err instanceof Error ? err.message : String(err));
    } finally {
      setCopyingFeedback(false);
    }
  }
  const copyFeedbackButton = <button className="small-muted-button pi-copy-feedback" onClick={() => void copyFeedback()} disabled={copyingFeedback}>{copyingFeedback ? "Copying…" : feedbackCopied ? "Copied feedback prompt" : "Copy feedback prompt"}</button>;
  if (!composing && !hasReviewContent) return <section className="panel review-summary-empty"><div><h2>Draft review</h2><p className="muted">{showSubmitted ? "Review submitted." : "No draft comments yet."}</p>{feedbackCopyError != null && <p className="muted copy-feedback-error" role="alert">Copy failed: {feedbackCopyError}</p>}</div><div className="review-summary-empty-actions">{copyFeedbackButton}<button className="small-muted-button" onClick={() => setComposing(true)}>Start review</button></div></section>;
  return <section className="panel"><div className="section-head"><h2>Draft review</h2>{copyFeedbackButton}</div>{feedbackCopyError != null && <p className="muted copy-feedback-error" role="alert">Copy failed: {feedbackCopyError}</p>}<select className={`review-event ${event.toLowerCase().replace("_", "-")}`} value={event} onChange={(change) => { setEvent(change.target.value as typeof event); setSubmitted(false); }}><option value="COMMENT">Not reviewed</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><textarea className="review-body" rows={2} value={body} onChange={(change) => { setBody(change.target.value); setSubmitted(false); autoGrowTextarea(change.currentTarget); }} placeholder="Overall review body" />{hasDrafts ? drafts.map((draft, index) => <DraftView key={draft.id} draft={draft} index={index} invalid={invalidDraftIds[draft.id] === true} drafts={drafts} setDrafts={setDrafts} editingDraftId={editingDraftId} setEditingDraftId={setEditingDraftId} onJump={onJumpToDraft != null ? () => onJumpToDraft(draft) : undefined} />) : <p className="muted">No draft comments yet.</p>}<div className="review-actions"><button className="small-muted-button" disabled={!hasReviewContent} onClick={() => void copyDraftContext()}>{copied ? "Copied context" : "Copy draft context"}</button><button className={`review-submit ${event.toLowerCase().replace("_", "-")}`} disabled={submitting || !hasReviewContent} onClick={() => void handleSubmit()}>{submitting ? "Submitting…" : `Submit review (${drafts.length})`}</button></div></section>;
}

function AgentActivityLine({ activity }: { activity: PiAgentActivity | null | undefined }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (activity?.status !== "running" && activity?.status !== "queued") return;
    const interval = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(interval);
  }, [activity?.status, activity?.startedAt, activity?.lastActivityAt]);
  const liveActivity = activity == null ? null : { ...activity, elapsedMs: activity.startedAt == null ? activity.elapsedMs : Date.now() - Date.parse(activity.startedAt), idleMs: activity.lastActivityAt == null || activity.idleMs == null ? activity.idleMs : Date.now() - Date.parse(activity.lastActivityAt) };
  const detail = liveActivity?.detail;
  return <span className={`agent-activity ${agentActivityTone(liveActivity)}`} role="status"><span className="agent-activity-line"><span className="agent-activity-pulse" aria-hidden="true" />{agentActivityText(liveActivity)}</span>{detail != null && detail.length > 0 && <span className="agent-activity-detail" title={detail}>{detail}</span>}</span>;
}

function AiReviewPanel({ prUrl, review, aiReviewHistory, aiReviewId, showAiReviewRecord, runReview, sendMessage, chatSending, clearFollowUp, copyFeedbackPrompt, focusReview, focusScanHistory, focusScanId, showFocusScanRecord, runFocusReview, focusAreas, setActiveFocusAreaId, collapsedFocusAreaIds, setCollapsedFocusAreaIds, viewedFocusIds, setViewedFocusIds, saveFocusScan, openFiles, setOpenFiles }: PiPanelProps & { prUrl: string; focusAreas: FocusArea[]; setActiveFocusAreaId: (id: string | null) => void; collapsedFocusAreaIds: Record<string, boolean>; setCollapsedFocusAreaIds: DiffProps["setCollapsedFocusAreaIds"]; openFiles: Record<string, boolean>; setOpenFiles: (open: Record<string, boolean>) => void }) {
  const [draftsByRecord, setDraftsByRecord] = useState<Record<string, string>>({});
  const [copyingFeedback, setCopyingFeedback] = useState(false);
  const [feedbackCopied, setFeedbackCopied] = useState(false);
  const [feedbackCopyError, setFeedbackCopyError] = useState<string | null>(null);
  const draftKey = aiReviewId ?? "__pending__";
  const draft = draftsByRecord[draftKey] ?? "";
  const setDraft = (text: string) => setDraftsByRecord((current) => ({ ...current, [draftKey]: text }));
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => autoGrowTextarea(composerRef.current), [draft, draftKey]);
  const focusAreaCount = focusAreas.length;
  const allFocusCollapsed = focusAreaCount > 0 && focusAreas.every((area) => collapsedFocusAreaIds[area.id]);
  const messages = currentAiReviewMessages(review);
  const hasMessages = messages.length > 0;
  const reviewMessages = messages.filter((message) => message.kind === "general-review");
  const chatMessages = messages.filter((message) => message.kind !== "general-review");
  const renderMessage = (message: AiReviewMessage, index: number) => {
    const isGeneralReview = message.kind === "general-review";
    return <details className={`ai-chat-message ${message.role}${isGeneralReview ? " general-review" : ""}`} key={index} open>
      <summary><span className="message-role">{message.title ?? (message.role === "user" ? "You" : "Pi")}</span></summary>
      <MarkdownText text={message.text} fileLinks={{ prUrl, snippets: false }} />
    </details>;
  };
  const body = messages.length > 0 ? <div className="ai-review-dialogue">
    {reviewMessages.length > 0 && <div className="ai-chat-messages ai-review-response">{reviewMessages.map(renderMessage)}</div>}
    {chatMessages.length > 0 && <div className="ai-chat-section"><div className="ai-chat-section-head"><span className="ai-chat-section-label">Chat</span><Button variant="muted" className="small-muted-button" onClick={clearFollowUp} disabled={chatSending} aria-label="Clear chat">Clear</Button></div><div className="ai-chat-messages">{chatMessages.map(renderMessage)}</div></div>}
  </div> : <p className="muted">Run review or ask Pi about this PR.</p>;
  async function copyFeedback() {
    if (copyingFeedback) return;
    setCopyingFeedback(true);
    setFeedbackCopyError(null);
    try {
      await copyFeedbackPrompt();
      setFeedbackCopied(true);
      window.setTimeout(() => setFeedbackCopied(false), 1600);
    } catch (err) {
      setFeedbackCopyError(err instanceof Error ? err.message : String(err));
    } finally {
      setCopyingFeedback(false);
    }
  }
  function submitChat() {
    if (draft.trim().length === 0 || chatSending) return;
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
  const composer = <div className="ai-chat-followup"><div className="ai-chat-divider"><span>Ask Pi about this PR</span></div><div className="ai-chat-composer"><textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onInput={(event) => autoGrowTextarea(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitChat(); } }} placeholder="Ask Pi about this PR…" /><Button variant="muted" onClick={submitChat} disabled={chatSending || draft.trim().length === 0}>{chatSending ? "Sending…" : "Send"}</Button></div>{chatSending && <AgentActivityLine activity={review.activity} />}</div>;
  const selectedAiReviewId = aiReviewId ?? "";
  const selectedFocusScanId = focusScanId ?? "";
  const latestAiReviewId = aiReviewHistory[0]?.id ?? null;
  const latestFocusScanId = focusScanHistory[0]?.id ?? null;
  const viewingOlderAiReview = latestAiReviewId != null && aiReviewId != null && aiReviewId !== latestAiReviewId;
  const viewingOlderFocusScan = latestFocusScanId != null && focusScanId != null && focusScanId !== latestFocusScanId;
  const viewingHistory = viewingOlderAiReview || viewingOlderFocusScan;
  const viewedCount = focusAreas.filter((area) => viewedFocusIds[area.id]).length;
  const allFocusReviewed = focusAreaCount > 0 && viewedCount === focusAreaCount;
  const focusLinksMinimized = allFocusReviewed && allFocusCollapsed;
  const focusHistoryOptions = focusScanHistory.map((record, index) => <option key={record.id} value={record.id}>{index === 0 ? "Latest · " : ""}{historyTimestamp(record)} · {focusScanSummary(record)}</option>);
  const aiHistoryOptions = aiReviewHistory.map((record, index) => {
    const question = firstUserQuestionText(record.messages);
    const questionCount = chatQuestionCount(record.messages);
    return <option key={record.id} value={record.id}>{index === 0 ? "Latest · " : ""}{historyTimestamp(record)} · {question.length > 0 ? question : "Findings only"}{questionCount > 0 ? ` (${questionCount})` : ""}</option>;
  });
  const focusAreaLinks = focusAreaCount > 0 && <div className={`focus-area-links${focusLinksMinimized ? " minimized" : ""}`} aria-label="Focus areas">
    <div className="focus-area-links-head">
      <strong>{viewedCount}/{focusAreaCount} focus area{focusAreaCount === 1 ? "" : "s"} reviewed</strong>
      <Button variant="muted" className="small-muted-button" onClick={toggleFocusAreas}>{allFocusCollapsed ? "Expand all" : "Collapse all"}</Button>
    </div>
    {!focusLinksMinimized && focusAreas.map((area, index) => {
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
  return <section className={`panel ai-review${viewingHistory ? " viewing-history" : ""}`}>
    <div className="section-head pi-panel-head"><h2>Pi{viewingHistory && <span className="pi-history-flag" role="status">Viewing earlier run</span>}</h2><Button type="button" variant="muted" className="small-muted-button pi-copy-feedback" onClick={() => void copyFeedback()} disabled={copyingFeedback}>{copyingFeedback ? "Copying…" : feedbackCopied ? "Copied feedback prompt" : "Copy feedback prompt"}</Button></div>
    {feedbackCopyError != null && <p className="muted copy-feedback-error" role="alert">Copy failed: {feedbackCopyError}</p>}
    <div className="pi-actions">
      <div className="pi-action">
        <Button className="focus-review-run" onClick={() => void runFocusReview()} disabled={focusReview.running}>{focusReview.running ? "Scanning…" : focusReview.text.length > 0 ? "Refresh focus scan" : "Focus scan"}</Button>
        {focusReview.running ? <AgentActivityLine activity={focusReview.activity} /> : <span className="muted">Find specific lines worth deeper review. Refresh saves each pass to quiet history.</span>}
        {focusScanHistory.length > 1 && <details className="pi-history-compact"><summary><span className="disclosure-chevron" aria-hidden="true">›</span>Focus scan history ({focusScanHistory.length})</summary><div className="pi-history-picker"><select aria-label="Focus scan history" value={selectedFocusScanId} onChange={(event) => showFocusScanRecord(focusScanHistory.find((record) => record.id === event.target.value))}>{focusHistoryOptions}</select>{viewingOlderFocusScan && <Button variant="muted" className="pi-history-back" onClick={() => showFocusScanRecord(focusScanHistory[0])}>Latest</Button>}</div></details>}
      </div>
      <div className="pi-action">
        <Button onClick={() => void runReview()} disabled={review.running}>{review.running ? "Reviewing…" : hasMessages ? "Refresh findings" : "Full review"}</Button>
        {review.running ? <AgentActivityLine activity={review.activity} /> : <span className="muted">Run a general code review. Follow-up chat stays with this run.</span>}
        {aiReviewHistory.length > 1 && <details className="pi-history-compact"><summary><span className="disclosure-chevron" aria-hidden="true">›</span>Review/chat history ({aiReviewHistory.length})</summary><div className="pi-history-picker"><select aria-label="Review chat history" value={selectedAiReviewId} onChange={(event) => showAiReviewRecord(aiReviewHistory.find((record) => record.id === event.target.value))}>{aiHistoryOptions}</select>{viewingOlderAiReview && <Button variant="muted" className="pi-history-back" onClick={() => showAiReviewRecord(aiReviewHistory[0])}>Latest</Button>}</div></details>}
      </div>
    </div>
    {focusReviewHasNoFindings(focusReview.text) && <div className="focus-review-note clean" role="status"><strong>✓ Focus scan clean.</strong><span>All scanned up for this pass.</span></div>}
    {focusAreaLinks}
    {body}{composer}
  </section>;
}

function GpuWorkspaceModal({ review, close, refreshLogs }: { review: OpenResponse; close: () => void; refreshLogs: () => Promise<void> }) {
  const [contract, setContract] = useState<GpuWorkspaceContract | null>(null);
  const [gpuType, setGpuType] = useState("");
  const [creating, setCreating] = useState(false);
  const [workspace, setWorkspace] = useState<GpuWorkspace | null>(null);
  const [execCommand, setExecCommand] = useState("nvidia-smi -L");
  const [execResult, setExecResult] = useState<GpuWorkspaceExecResult | null>(null);
  const [executing, setExecuting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = contract != null && review.pr.key.toLowerCase().startsWith(contract.supportedPrKeyPrefix.toLowerCase());
  const supportedRepositoryLabel = contract?.supportedRepository.replace(/^github\.com\//, "") ?? "supported repository";

  useEffect(() => {
    void api<{ workspace: GpuWorkspace | null; contract: GpuWorkspaceContract }>("/api/gpu/workspaces/status", { method: "POST", body: JSON.stringify({ prKey: review.pr.key }) }).then((data) => {
      setContract(data.contract);
      setGpuType((current) => current || data.contract.defaults.gpuType);
      setWorkspace(data.workspace);
    }).catch(() => undefined);
  }, [review.pr.key]);

  async function createWorkspace() {
    if (!supported || workspace != null || contract == null || gpuType.trim().length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const data = await api<{ workspace: GpuWorkspace }>("/api/gpu/workspaces", { method: "POST", body: JSON.stringify({ prUrl: review.pr.url, gpuType, gpuCount: contract.defaults.gpuCount, ttlHours: contract.defaults.ttlHours }) });
      setWorkspace(data.workspace);
      setExecResult(null);
      await refreshLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function runWorkspaceCommand() {
    if (workspace?.id == null || execCommand.trim().length === 0) return;
    setExecuting(true);
    setError(null);
    try {
      const { result } = await api<{ result: GpuWorkspaceExecResult }>("/api/gpu/workspaces/exec", { method: "POST", body: JSON.stringify({ id: workspace.id, command: execCommand.trim() }) });
      setExecResult(result);
      await refreshLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }

  async function deleteWorkspace(): Promise<boolean> {
    if (workspace?.id == null) {
      setWorkspace(null);
      setExecResult(null);
      return true;
    }
    setDeleting(true);
    setError(null);
    try {
      await api("/api/gpu/workspaces/delete", { method: "POST", body: JSON.stringify({ id: workspace.id, prKey: review.pr.key }) });
      setWorkspace(null);
      setExecResult(null);
      await refreshLogs();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setDeleting(false);
    }
  }

  async function requestClose() {
    if (workspace == null) {
      close();
      return;
    }
    if (await deleteWorkspace()) close();
  }

  async function copy(text: string | null) {
    if (text != null) await navigator.clipboard.writeText(text);
  }

  return <ModalShell open onOpenChange={(open) => { if (!open) void requestClose(); }} label="GPU workspace" className="pi-modal gpu-workspace-modal">
    <header className="pi-modal-head">
      <div>
        <h2>GPU workspace</h2>
        <p className="muted">Fast PyTorch scratch box for {review.pr.key}. {contract == null ? "Loading workspace contract…" : `MVP uses ${contract.defaults.gpuCount} GPU, ${contract.defaults.persistentDisk ? "persistent disk" : "no persistent disk"}, and a ${Math.round(contract.defaults.ttlHours * 60)} minute TTL.`}</p>
      </div>
    </header>
    <div className="pi-modal-body gpu-workspace-body">
      <PiCard title="Allocate fast workspace">
        <div className="gpu-workspace-form">
          <label>Hardware<select value={gpuType} onChange={(event) => setGpuType(event.target.value)}>{(contract?.gpuTypes ?? []).map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
          <div className="gpu-workspace-defaults"><span>{contract?.defaults.gpuCount ?? "—"} GPU</span><span>{contract == null ? "—" : contract.defaults.persistentDisk ? "persistent disk" : "no persistent disk"}</span><span>{contract == null ? "—" : `${Math.round(contract.defaults.ttlHours * 60)}m TTL`}</span><span>{contract == null ? "—" : contract.defaults.autoConnect ? "auto-connect" : "no auto-connect"}</span></div>
          <Button onClick={() => void createWorkspace()} disabled={creating || workspace != null || !supported || gpuType.trim().length === 0}>{creating ? "Allocating…" : workspace != null ? "Workspace open" : "Open GPU workspace"}</Button>
        </div>
        <p className="muted">{supported ? "Use this when you want Pi or a local agent to write a repro, run it on specific hardware, then attach if needed. The reservation stays on the warm-pool path; PR checkout is a follow-up command." : contract == null ? "Loading GPU workspace support contract…" : `This first MVP only supports ${supportedRepositoryLabel} PR checkouts. The flow is intentionally narrow so repo setup can become a later profile layer.`}</p>
      </PiCard>
      {error != null && <p className="error">{error}</p>}
      {workspace != null && <PiCard title="Workspace ready" count={workspace.id ?? workspace.gpuType}>
        <div className="gpu-workspace-ready-actions"><Button variant="muted" className="small-muted-button" onClick={() => void deleteWorkspace()} disabled={deleting}>{deleting ? "Deleting…" : "Delete workspace"}</Button></div>
        <dl className="pi-kv">
          <dt>Workspace</dt><dd><code>{workspace.uri ?? "ID not detected from gpu-dev output"}</code></dd>
          <dt>Attach</dt><dd>{workspace.attachCommand == null ? "Run gpu-dev list/show to find the reservation." : <><code>{workspace.attachCommand}</code><button type="button" className="small-muted-button" onClick={() => void copy(workspace.attachCommand)}>Copy</button></>}</dd>
          <dt>Inspect</dt><dd>{workspace.showCommand == null ? "—" : <><code>{workspace.showCommand}</code><button type="button" className="small-muted-button" onClick={() => void copy(workspace.showCommand)}>Copy</button></>}</dd>
          <dt>SSH host</dt><dd>{workspace.sshHost ?? "—"}</dd>
          <dt>Setup</dt><dd><code>{workspace.setupCommand}</code><button type="button" className="small-muted-button" onClick={() => void copy(workspace.setupCommand)}>Copy</button></dd>
          <dt>Profile</dt><dd>{workspace.setupProfile}</dd>
          <dt>Ref</dt><dd>{workspace.prRef}</dd>
          <dt>GPU</dt><dd>{workspace.gpuCount}× {workspace.gpuType}</dd>
          <dt>TTL</dt><dd>{Math.round(workspace.ttlHours * 60)} minutes</dd>
        </dl>
        <div className="gpu-workspace-exec">
          <label>Run command<textarea value={execCommand} onChange={(event) => setExecCommand(event.target.value)} /></label>
          <Button onClick={() => void runWorkspaceCommand()} disabled={executing || workspace.id == null || execCommand.trim().length === 0}>{executing ? "Running…" : "Run on workspace"}</Button>
        </div>
        {execResult != null && <details className="gpu-workspace-output" open><summary><span className="disclosure-chevron" aria-hidden="true">›</span>Command result · exit {execResult.exitCode ?? execResult.signal ?? "unknown"}</summary><pre>{[execResult.stdout, execResult.stderr].filter((text) => text.trim().length > 0).join("\n") || "No output"}</pre></details>}
        <details className="gpu-workspace-output"><summary><span className="disclosure-chevron" aria-hidden="true">›</span>Setup script</summary><pre>{workspace.setupScript}</pre></details>
        <details className="gpu-workspace-output"><summary><span className="disclosure-chevron" aria-hidden="true">›</span>gpu-dev output</summary><pre>{[workspace.stdout, workspace.stderr].filter((text) => text.trim().length > 0).join("\n") || workspace.command}</pre></details>
      </PiCard>}
      <GpuWorkspaceAgentPanel review={review} supported={supported} />
    </div>
  </ModalShell>;
}

function GpuWorkspaceAgentPanel({ review, supported }: { review: OpenResponse; supported: boolean }) {
  const [prompt, setPrompt] = useState("Allocate a GPU workspace if needed, run nvidia-smi -L, and summarize the result.");
  const [answer, setAnswer] = useState("");
  const [activity, setActivity] = useState<PiAgentActivity | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function askGpuAgent() {
    if (!supported || prompt.trim().length === 0) return;
    const initialActivity = runningAgentActivity("gpu-workspace");
    const cancelActivityPolling = startPiAgentActivityPolling(review.pr.key, "gpu-workspace", setActivity, initialActivity);
    setRunning(true);
    setActivity(initialActivity);
    setError(null);
    setAnswer("");
    try {
      await askPiApi({ prKey: review.pr.key, purpose: "gpu-workspace", prompt: prompt.trim() }, (text) => {
        setActivity((current) => streamingAgentActivity(current, text));
        setAnswer(text);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      cancelActivityPolling();
      setActivity(null);
      setRunning(false);
    }
  }

  return <PiCard title="Workspace agent">
    <p className="muted">Dedicated Pi thread with the shared gpu_workspace tool. It can allocate, inspect, delete, and run commands without queueing behind the main review chat.</p>
    <div className="gpu-workspace-agent">
      <label>Ask workspace agent<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <Button onClick={() => void askGpuAgent()} disabled={!supported || running || prompt.trim().length === 0}>{running ? "Asking…" : "Ask workspace agent"}</Button>
    </div>
    {running && <AgentActivityLine activity={activity} />}
    {error != null && <p className="error">{error}</p>}
    {answer.trim().length > 0 && <div className="gpu-workspace-agent-answer"><MarkdownText text={answer} /></div>}
  </PiCard>;
}

function FlowDagModal({ flowDag, runFlowDag, close, prUrl, headSha }: { flowDag: FlowDag; runFlowDag: () => Promise<void>; close: () => void; prUrl: string; headSha: string }) {
  const [expanded, setExpanded] = useState(false);
  const [highRes, setHighRes] = useState(true);
  const modalClassName = `pi-modal flow-dag-modal${expanded ? " expanded" : ""}${highRes ? " high-res" : ""}`;

  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Code walk" className={modalClassName}>
    <header className="pi-modal-head">
      <div>
        <h2>Code walk</h2>
        <p className="muted">Architecture, data flow, and key snippets for this PR.</p>
      </div>
      <div className="pi-modal-head-actions">
        {flowDag.running && <AgentActivityLine activity={flowDag.activity} />}
        <Button variant="muted" className="small-muted-button" onClick={() => setHighRes((current) => !current)} aria-pressed={highRes}>{highRes ? "Standard DPI" : "High DPI"}</Button>
        <Button variant="muted" className="small-muted-button" onClick={() => setExpanded((current) => !current)} aria-pressed={expanded}>{expanded ? "Compact" : "Expand"}</Button>
        <Button variant="muted" className="small-muted-button" onClick={() => void runFlowDag()} disabled={flowDag.running}>{flowDag.running ? "Refreshing…" : flowDag.text.trim().length > 0 ? "Refresh" : "Build"}</Button>
      </div>
    </header>
    <div className="flow-dag-body">
      {flowDag.error != null && <p className="muted">Code walk failed: {flowDag.error}</p>}
      {flowDag.text.trim().length === 0 && !flowDag.error && flowDag.running && <p className="muted">Asking Pi for a guided code walk…</p>}
      {flowDag.text.trim().length === 0 && !flowDag.error && !flowDag.running && <p className="muted">Build a code walk to orient the review.</p>}
      {flowDag.text.trim().length > 0 && <InlineSnippetsProvider value={{ headSha, snippets: false }}><MarkdownText text={flowDag.text} fileLinks={{ prUrl }} /></InlineSnippetsProvider>}
    </div>
  </ModalShell>;
}

function diagnosticsText(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function diagnosticsArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function PiCard({ title, count, defaultOpen, children }: { title: string; count?: number | string | null; defaultOpen?: boolean; children: ReactNode }) {
  return <details className="pi-card" open={defaultOpen ?? true}>
    <summary className="pi-card-summary">
      <span className="pi-card-chevron" aria-hidden="true">›</span>
      <span className="pi-card-title">{title}</span>
      {count != null && count !== "" && <span className="pi-card-count">{count}</span>}
    </summary>
    <div className="pi-card-body">{children}</div>
  </details>;
}

function DiagnosticsView({ diagnostics }: { diagnostics: Record<string, unknown> | null }) {
  if (diagnostics == null) return <p className="muted">Loading Pi diagnostics…</p>;
  const activeTools = diagnosticsArray(diagnostics.activeTools);
  const tools = diagnosticsArray(diagnostics.tools);
  const models = diagnosticsArray(diagnostics.availableModels);
  const lastPrompt = diagnostics.lastPrompt as { chars?: number; preview?: string; startedAt?: string } | null;
  const sessions = diagnosticsArray(diagnostics.sessions) as Array<{ purpose?: string; ready?: boolean; queued?: boolean; isStreaming?: boolean | null; activeTools?: unknown[]; lastPrompt?: { chars?: number; preview?: string; startedAt?: string } | null; promptState?: { status?: string; elapsedMs?: number; chars?: number; answerChars?: number; error?: string } | null }>;
  return <div className="pi-card-stack">
    <PiCard title="Pi session health" count={sessions.length > 0 ? sessions.length : null}>
      {sessions.length === 0 ? <p className="muted pi-empty">No Pi sessions for this PR yet.</p> : <div className="pi-session-list">{sessions.map((session) => <div className="pi-session" key={session.purpose}>
        <div className="pi-session-head">
          <span className={`pi-status-dot pi-status-${session.ready ? "ready" : "creating"}`} aria-hidden="true" />
          <span className="pi-session-purpose">{session.purpose} · {session.ready ? "ready" : "creating"}{session.queued ? " · queued" : ""}{session.isStreaming ? " · streaming" : ""}</span>
        </div>
        <p className="pi-session-state muted">{session.promptState == null ? "No prompt state" : `${session.promptState.status ?? "unknown"} · ${Math.round((session.promptState.elapsedMs ?? 0) / 1000)}s · ${session.promptState.chars ?? 0} prompt chars · ${session.promptState.answerChars ?? 0} answer chars`}</p>
        {session.promptState?.error != null && <code className="pi-session-error">{session.promptState.error}</code>}
        {session.lastPrompt?.preview != null && <pre className="prompt-preview">{session.lastPrompt.preview}</pre>}
      </div>)}</div>}
    </PiCard>
    <PiCard title="Session info">
      <dl className="pi-kv">
        <dt>PR key</dt><dd>{diagnosticsText(diagnostics.prKey)}</dd>
        <dt>CWD</dt><dd>{diagnosticsText(diagnostics.cwd)}</dd>
        <dt>Session file</dt><dd>{diagnosticsText(diagnostics.sessionFile)}</dd>
        <dt>Session ID</dt><dd>{diagnosticsText(diagnostics.sessionId)}</dd>
      </dl>
    </PiCard>
    <PiCard title="Last chat prompt" count={lastPrompt?.chars ?? null}>
      {lastPrompt == null ? <p className="muted pi-empty">No prompt sent yet.</p> : <>
        <p className="muted pi-card-meta">{lastPrompt.chars ?? 0} chars · {lastPrompt.startedAt ?? "unknown time"}</p>
        <pre className="prompt-preview">{lastPrompt.preview}</pre>
      </>}
    </PiCard>
    <PiCard title="Active tools" count={activeTools.length}>
      {activeTools.length === 0 ? <p className="muted pi-empty">No tools active.</p> : <div className="chip-list">{activeTools.map((tool, index) => <span className="chip" key={index}>{diagnosticsText(tool)}</span>)}</div>}
    </PiCard>
    <PiCard title="Available models" count={models.length} defaultOpen={false}>
      <div className="pi-code-list">{models.map((model, index) => <code key={index}>{diagnosticsText(model)}</code>)}</div>
    </PiCard>
    <PiCard title="All tool definitions" count={tools.length} defaultOpen={false}>
      <div className="pi-code-list">{tools.map((tool, index) => <code key={index}>{diagnosticsText(tool)}</code>)}</div>
    </PiCard>
    <PiCard title="Raw diagnostics" defaultOpen={false}>
      <pre className="diagnostics-json">{JSON.stringify(diagnostics, null, 2)}</pre>
    </PiCard>
  </div>;
}

function PiRunDiagnostics({ aiReview, focusReview, focusAreaCount }: { aiReview: AiReview; focusReview: FocusReview; focusAreaCount: number }) {
  const reviewStatus = aiReview.running ? "running" : aiReview.messages.length > 0 ? `${aiReview.messages.length} messages` : "idle";
  const focusStatus = focusReview.running ? "running" : focusReview.text.length === 0 ? "not run" : focusAreaCount > 0 ? `${focusAreaCount} findings` : "clean";
  return <div className="pi-card-stack">
    <PiCard title="Pi runs">
      <div className="pi-mini-grid">
        <div><span>Review chat</span><strong>{reviewStatus}</strong></div>
        <div><span>Focus scan</span><strong>{focusStatus}</strong></div>
      </div>
    </PiCard>
    {focusReview.text.length > 0 && <PiCard title="Focus scan output"><pre className="prompt-preview">{focusReview.text}</pre></PiCard>}
    {aiReview.text.length > 0 && <PiCard title="Latest Pi review/chat answer" defaultOpen={false}><pre className="prompt-preview">{aiReview.text}</pre></PiCard>}
  </div>;
}

function DiagnosticsModal({ diagnostics, aiReview, focusReview, focusAreaCount, refresh, close }: { diagnostics: Record<string, unknown>; aiReview: AiReview; focusReview: FocusReview; focusAreaCount: number; refresh: () => Promise<Record<string, unknown> | null>; close: () => void }) {
  const activeTools = diagnosticsArray(diagnostics.activeTools);
  const models = diagnosticsArray(diagnostics.availableModels);
  const sessions = diagnosticsArray(diagnostics.sessions);
  const [refreshing, setRefreshing] = useState(false);
  async function handleRefresh() {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Pi diagnostics" className="pi-modal pi-diagnostics-modal">
    <header className="pi-modal-head">
      <div>
        <h2>Pi diagnostics</h2>
        <p className="muted">Read-only snapshot of this PR's Pi sessions</p>
      </div>
      <div className="pi-modal-head-actions">
        <Button variant="muted" onClick={() => void handleRefresh()} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh"}</Button>
      </div>
    </header>
    <div className="pi-modal-summary">
      <div><span>Model</span><strong title={diagnosticsText(diagnostics.model)}>{diagnosticsText(diagnostics.model)}</strong></div>
      <div><span>Reasoning</span><strong><span className="pi-pill">{diagnosticsText(diagnostics.thinkingLevel)}</span></strong></div>
      <div><span>Sessions</span><strong>{sessions.length}</strong></div>
      <div><span>Active tools</span><strong>{activeTools.length}</strong></div>
      <div><span>Available models</span><strong>{models.length}</strong></div>
    </div>
    <div className="pi-modal-body">
      <PiRunDiagnostics aiReview={aiReview} focusReview={focusReview} focusAreaCount={focusAreaCount} />
      <DiagnosticsView diagnostics={diagnostics} />
    </div>
  </ModalShell>;
}

const THINKING_DESCRIPTIONS: Record<string, string> = {
  off: "Answer directly without a reasoning pass",
  minimal: "Tiny scratchpad before answering",
  low: "Brief reasoning, fastest thoughtful tier",
  medium: "Balanced reasoning depth (default)",
  high: "Slower, deeper analysis",
  xhigh: "Maximum reasoning effort",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  anthropic: "Anthropic",
  google: "Google",
  gemini: "Gemini",
  xai: "xAI",
  meta: "Meta",
  groq: "Groq",
};

type PiModelOption = { provider?: string; id?: string; name?: string };

function PiSettingsModal({ prKey, diagnostics, setDiagnostics, openDiagnostics, close }: { prKey: string; diagnostics: Record<string, unknown> | null; setDiagnostics: (diagnostics: Record<string, unknown>) => void; openDiagnostics: () => void; close: () => void }) {
  const models = (Array.isArray(diagnostics?.availableModels) ? diagnostics.availableModels as PiModelOption[] : []).filter((model) => typeof model.provider === "string" && typeof model.id === "string");
  const thinkingLevels = (() => {
    const raw = Array.isArray(diagnostics?.availableThinkingLevels) ? diagnostics.availableThinkingLevels as unknown[] : [];
    const filtered = raw.filter((value): value is string => typeof value === "string" && value.length > 0);
    return filtered.length > 0 ? filtered : ["off", "minimal", "low", "medium", "high", "xhigh"];
  })();
  const currentModel = typeof diagnostics?.model === "string" ? diagnostics.model : "";
  const currentProvider = currentModel.includes("/") ? currentModel.slice(0, currentModel.indexOf("/")) : "";
  const currentModelId = currentModel.includes("/") ? currentModel.slice(currentModel.indexOf("/") + 1) : "";
  const currentThinking = typeof diagnostics?.thinkingLevel === "string" ? diagnostics.thinkingLevel : "";

  const providers = useMemo(() => {
    const seen = new Set<string>();
    for (const model of models) if (typeof model.provider === "string") seen.add(model.provider);
    return Array.from(seen).sort();
  }, [models]);

  const [provider, setProvider] = useState(currentProvider !== "" ? currentProvider : providers[0] ?? "");
  const [modelId, setModelId] = useState(currentModelId);
  const [thinking, setThinking] = useState(currentThinking);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (currentProvider !== "" && providers.includes(currentProvider)) setProvider(currentProvider);
    else if (providers.length > 0 && !providers.includes(provider)) setProvider(providers[0]);
    if (currentModelId !== "") setModelId(currentModelId);
    if (currentThinking !== "") setThinking(currentThinking);
  }, [currentProvider, currentModelId, currentThinking, providers.join("|")]);

  const filteredModels = models.filter((model) => model.provider === provider && (filter.trim().length === 0 || `${model.id ?? ""} ${model.name ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase())));
  const modelChanged = modelId.length > 0 && `${provider}/${modelId}` !== currentModel;
  const thinkingChanged = thinking.length > 0 && thinking !== currentThinking;
  const hasChanges = modelChanged || thinkingChanged;

  async function apply() {
    if (provider.length === 0 || modelId.length === 0) return;
    setSaving(true);
    setApplyError(null);
    try {
      const data = await api<{ diagnostics: Record<string, unknown> }>("/api/pi/model", { method: "POST", body: JSON.stringify({ prKey, provider, modelId, thinkingLevel: thinking }) });
      setDiagnostics(data.diagnostics);
      setSavedAt(Date.now());
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Pi settings" className="pi-modal pi-settings-modal">
    <header className="pi-modal-head">
      <div>
        <h2>Pi settings</h2>
        <p className="muted">Applies to this PR session</p>
      </div>
    </header>

    <div className="pi-modal-summary">
      <div>
        <span>Model</span>
        <strong title={currentModel || undefined}>{currentModel || "—"}</strong>
      </div>
      <div>
        <span>Reasoning</span>
        <strong><span className="pi-pill">{currentThinking || "default"}</span></strong>
      </div>
      <div>
        <span>Available models</span>
        <strong>{models.length}</strong>
      </div>
    </div>

    <div className="pi-modal-body">
      <section className="pi-settings-section">
        <div className="pi-settings-section-head">
          <h3>Model</h3>
          <input className="pi-settings-search" type="search" placeholder="Filter models…" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </div>
        {providers.length === 0 ? <p className="muted">No models reported by this Pi session yet.</p> : <>
          <div className="pi-provider-tabs" role="tablist" aria-label="Provider">
            {providers.map((entry) => {
              const count = models.filter((model) => model.provider === entry).length;
              const isActive = entry === provider;
              const isCurrent = entry === currentProvider;
              return <button key={entry} type="button" role="tab" aria-selected={isActive} className={`pi-provider-tab${isActive ? " active" : ""}${isCurrent ? " current" : ""}`} onClick={() => { setProvider(entry); setModelId(entry === currentProvider ? currentModelId : ""); }}>{PROVIDER_LABELS[entry] ?? entry}<span className="pi-count">{count}</span></button>;
            })}
          </div>
          <div className="pi-model-options" role="radiogroup" aria-label="Model">
            {filteredModels.length === 0 ? <p className="muted pi-empty">No models match this filter.</p> : filteredModels.map((model) => {
              const id = model.id ?? "";
              const value = `${model.provider}/${id}`;
              const isSelected = modelId === id;
              const isCurrent = value === currentModel;
              return <label key={value} className={`pi-model-option${isSelected ? " selected" : ""}${isCurrent ? " current" : ""}`}>
                <input type="radio" name="pi-model" checked={isSelected} onChange={() => setModelId(id)} />
                <div className="pi-model-meta">
                  <span className="pi-model-id">{id}</span>
                  {model.name != null && model.name !== id && <span className="pi-model-name muted">{model.name}</span>}
                </div>
                {isCurrent && <span className="pi-tag">Current</span>}
              </label>;
            })}
          </div>
        </>}
      </section>

      <section className="pi-settings-section">
        <div className="pi-settings-section-head">
          <h3>Reasoning effort</h3>
        </div>
        <div className="pi-thinking-options" role="radiogroup" aria-label="Reasoning effort">
          {thinkingLevels.map((level) => {
            const isSelected = thinking === level;
            const isCurrent = level === currentThinking;
            return <label key={level} className={`pi-thinking-option${isSelected ? " selected" : ""}${isCurrent ? " current" : ""}`}>
              <input type="radio" name="pi-thinking" checked={isSelected} onChange={() => setThinking(level)} />
              <div className="pi-thinking-meta">
                <span className="pi-thinking-label">{level}</span>
                <span className="muted">{THINKING_DESCRIPTIONS[level] ?? ""}</span>
              </div>
              {isCurrent && <span className="pi-tag">Current</span>}
            </label>;
          })}
        </div>
      </section>
    </div>

    <footer className="pi-modal-foot">
      <button type="button" className="pi-link-button" onClick={() => { close(); openDiagnostics(); }}>View diagnostics →</button>
      <div className="pi-modal-foot-actions">
        {applyError != null && <span className="pi-settings-error">{applyError}</span>}
        {savedAt != null && applyError == null && !hasChanges && !saving && <span className="pi-settings-saved muted">Saved</span>}
        {hasChanges && !saving && <span className="pi-settings-pending muted">Unsaved changes</span>}
        <button type="button" onClick={close}>Cancel</button>
        <button type="button" className="pi-primary" onClick={() => void apply()} disabled={!hasChanges || saving || modelId.length === 0}>{saving ? "Applying…" : "Apply"}</button>
      </div>
    </footer>
  </ModalShell>;
}
type ReviewMemoryTab = "profile" | "examples" | "prompt";

function reviewMemoryProfileSections(text: string): string[] {
  return [...text.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]).filter((section) => section.length > 0);
}

function reviewMemoryRecordTitle(record: ReviewMemoryRecord): string {
  return `${record.prKey} · ${record.event} · ${relativeTime(record.createdAt)}`;
}

function reviewMemoryChangeSetSummary(record: ReviewMemoryRecord): string {
  if (record.changeSet == null) return "No change-set snapshot stored.";
  const fileCount = record.changeSet.files.length;
  const stats = record.changeSet.files.reduce((total, file) => ({ additions: total.additions + (file.additions ?? 0), deletions: total.deletions + (file.deletions ?? 0) }), { additions: 0, deletions: 0 });
  return `${fileCount} files · +${stats.additions} -${stats.deletions}`;
}

function reviewMemoryLocation(comment: ReviewMemoryRecord["comments"][number]): string {
  const line = comment.line == null ? "file" : comment.startLine != null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : comment.line;
  return `${comment.path}:${line}`;
}

function ReviewMemoryModal({ memory, loading, distilling, refresh, distill, close }: { memory: ReviewMemoryResponse | null; loading: boolean; distilling: boolean; refresh: () => void; distill: () => void; close: () => void }) {
  const [tab, setTab] = useState<ReviewMemoryTab>("profile");
  const profileText = memory?.profile?.text.trim() ?? "";
  const profileSections = profileText.length === 0 ? [] : reviewMemoryProfileSections(profileText);
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Review memory" className="pi-modal review-memory-modal">
    <header className="pi-modal-head">
      <div>
        <h2>Review memory</h2>
        <p className="muted">Raw review feedback becomes examples; distillation turns it into prompt rules.</p>
      </div>
      <div className="pi-modal-head-actions">
        <Button variant="muted" onClick={refresh} disabled={loading || distilling}>{loading ? "Refreshing…" : "Refresh"}</Button>
        <button type="button" className="pi-primary" onClick={distill} disabled={loading || distilling || (memory?.stats.recordCount ?? 0) === 0}>{distilling ? "Distilling…" : "Distill profile"}</button>
      </div>
    </header>
    {memory == null ? <div className="pi-modal-body"><p className="muted">{loading ? "Loading review memory…" : "No review memory loaded yet."}</p></div> : <>
      <div className="pi-modal-summary review-memory-summary">
        <div><span>Raw reviews</span><strong>{memory.stats.recordCount}</strong></div>
        <div><span>Inline comments</span><strong>{memory.stats.inlineCommentCount}</strong></div>
        <div><span>Sources</span><strong>{memory.stats.prCount}</strong></div>
        <div><span>Profile</span><strong>{memory.profile == null ? "not distilled" : relativeTime(memory.profile.updatedAt)}</strong></div>
        <div><span>Profile records</span><strong>{memory.profile?.sourceRecordCount ?? "—"}</strong></div>
      </div>
      <nav className="memory-tabs" role="tablist" aria-label="Review memory sections">
        {(["profile", "examples", "prompt"] as const).map((id) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{id === "profile" ? "Distilled profile" : id === "examples" ? "Raw examples" : "Prompt context"}</button>)}
      </nav>
      <div className="pi-modal-body review-memory-body">
        {tab === "profile" && <section className="memory-section">
          {profileText.length === 0 ? <div className="memory-empty"><h3>No distilled profile yet</h3><p className="muted">Capture a few reviews, then run distillation to turn them into actionable review rules.</p></div> : <>
            <div className="memory-distillation-map">
              <h3>Current distillation</h3>
              <p className="muted">These sections are injected before examples in future review prompts.</p>
              <div className="chip-list">{profileSections.map((section) => <span className="chip" key={section}>{section}</span>)}</div>
            </div>
            <MarkdownText text={profileText} />
          </>}
        </section>}
        {tab === "examples" && <section className="memory-section memory-examples">
          {memory.records.length === 0 ? <p className="muted">No raw examples captured yet.</p> : memory.records.map((record) => <details className="memory-record" key={record.id}>
            <summary><span className="disclosure-chevron" aria-hidden="true">›</span><strong>{reviewMemoryRecordTitle(record)}</strong><span>{record.comments.length} inline · head {shortSha(record.headSha)}</span></summary>
            {record.body.trim().length > 0 && <div className="memory-record-block"><h4>Overall</h4><MarkdownText text={record.body} /></div>}
            <div className="memory-record-block"><h4>Inline comments</h4>{record.comments.length === 0 ? <p className="muted">No inline comments.</p> : record.comments.map((comment, index) => <div className="memory-comment" key={index}><span>{reviewMemoryLocation(comment)}</span><p>{comment.body}</p></div>)}</div>
            <div className="memory-record-block"><h4>Change-set context</h4>{record.changeSet == null ? <p className="muted">No change-set snapshot stored for this record.</p> : <><p className="muted">{record.changeSet.title ?? record.changeSet.source ?? "Stored diff context"} · {reviewMemoryChangeSetSummary(record)}</p>{record.changeSet.files.map((file) => <details className="memory-file" key={file.path}><summary><span className="disclosure-chevron" aria-hidden="true">›</span>{file.path}<span>{file.status ?? ""} {file.additions == null ? "" : `+${file.additions}`} {file.deletions == null ? "" : `-${file.deletions}`}</span></summary><pre className="prompt-preview memory-file-patch">{file.patch ?? "Patch unavailable."}</pre></details>)}</>}</div>
          </details>)}
        </section>}
        {tab === "prompt" && <section className="memory-section">
          <p className="muted">This is the exact review memory context sent to Pi Review prompts and exposed to the `/review` workflow.</p>
          <pre className="prompt-preview memory-prompt-preview">{memory.prompt}</pre>
        </section>}
      </div>
    </>}
  </ModalShell>;
}

function LogsModal({ logs, refreshLogs, close }: { logs: LogEntry[]; refreshLogs: () => Promise<void>; close: () => void }) {
  return <ModalShell open onOpenChange={(open) => { if (!open) close(); }} label="Server log" className="pi-modal logs-modal">
    <header className="pi-modal-head">
      <div><h2>Server log</h2></div>
      <div className="pi-modal-head-actions"><Button variant="muted" onClick={() => void refreshLogs()}>Refresh</Button></div>
    </header>
    <div className="logs-modal-body">{logs.length === 0 ? <p className="muted">No log entries yet.</p> : <LogRows logs={logs} />}</div>
  </ModalShell>;
}

function LogRows({ logs }: { logs: LogEntry[] }) { return <>{logs.map((log) => <div className={`log ${log.level}`} key={log.id}><span>{new Date(log.timestamp).toLocaleTimeString()} {log.scope}</span><p>{log.message}</p>{log.data !== undefined && <code>{JSON.stringify(log.data)}</code>}</div>)}</>; }

createRoot(document.getElementById("root")!).render(<App />);
