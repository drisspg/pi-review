import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 43133;
const STATE_ROOT = resolve(homedir(), ".pi", "agent", "state", "github-pr-review");

type PullRequestRef = {
  host: string;
  owner: string;
  repo: string;
  number: number;
};

type GitHubUser = { login?: string } | null;
type GitHubRepo = { full_name: string; clone_url: string; html_url: string; default_branch?: string };
type PullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  body?: string | null;
  user?: GitHubUser;
  base: { ref: string; sha: string; repo: GitHubRepo };
  head: { ref: string; sha: string; repo: GitHubRepo | null };
};

type PullFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type PullReviewComment = {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: ReviewLineSide | null;
  original_side?: ReviewLineSide | null;
  body: string;
  html_url: string;
  user?: GitHubUser;
  updated_at?: string;
};

type ReviewLineSide = "RIGHT" | "LEFT";
type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

type DraftComment = {
  id?: string;
  path: string;
  line: number | null;
  side: ReviewLineSide;
  body: string;
};

type SubmitPayload = {
  event: ReviewEvent;
  body: string;
  comments: DraftComment[];
};

type AskPayload = {
  path: string;
  line: number | null;
  side: ReviewLineSide;
  question: string;
  hunk?: string;
  threadKey?: string;
};

type LocalCheckout = {
  cacheDir: string;
  worktreeDir: string;
};

type ProgressSink = (message: string) => void;

type ReviewSessionData = {
  ref: PullRequestRef;
  pr: PullRequest;
  files: PullFile[];
  reviewComments: PullReviewComment[];
  local: LocalCheckout;
  port: number;
  url: string;
};

type ActiveSession = {
  server: ReturnType<typeof createServer>;
  url: string;
  ref?: PullRequestRef;
  eventClients: Set<ServerResponse>;
  activeQuestions: Map<string, { threadKey: string | null; lastAssistantText: string }>;
};

type CleanupResult = {
  removedWorktreeRoot: boolean;
  prunedRepos: number;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeInlineJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function sanitizePathComponent(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function parseArgs(args: string): { port: number; explicitPort: boolean; apiOnly: boolean; url: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const envPort = Number.parseInt(process.env.PI_GITHUB_PR_REVIEW_PORT ?? "", 10);
  let port = envPort;
  let explicitPort = Number.isInteger(envPort);
  let apiOnly = false;
  const rest: string[] = [];

  for (const token of tokens) {
    if (token === "--api-only") {
      apiOnly = true;
      continue;
    }
    if (token.startsWith("--port=")) {
      port = Number.parseInt(token.slice("--port=".length), 10);
      explicitPort = true;
      continue;
    }
    rest.push(token);
  }

  return { port: Number.isInteger(port) ? port : DEFAULT_PORT, explicitPort, apiOnly, url: rest[0] ?? "" };
}

function parsePullRequestUrl(raw: string): PullRequestRef {
  const input = raw.trim();
  const shorthand = input.match(/^([^\s/#]+)\/([^\s/#]+)#(\d+)$/);
  if (shorthand != null) {
    return { host: "github.com", owner: shorthand[1], repo: shorthand[2], number: Number.parseInt(shorthand[3], 10) };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Usage: /pr-review https://github.com/OWNER/REPO/pull/NUMBER");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new Error("Expected a GitHub pull request URL like https://github.com/OWNER/REPO/pull/NUMBER");
  }
  const number = Number.parseInt(parts[3], 10);
  if (!Number.isInteger(number)) throw new Error(`Invalid pull request number: ${parts[3]}`);
  return { host: url.hostname, owner: parts[0], repo: parts[1], number };
}

function canListenOnPort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createNetServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolvePort(true));
    });
  });
}

async function resolveReviewPort(requestedPort: number, explicit: boolean): Promise<number> {
  if (explicit || await canListenOnPort(requestedPort)) return requestedPort;
  for (let port = requestedPort + 1; port <= Math.min(65535, requestedPort + 30); port += 1) {
    if (await canListenOnPort(port)) return port;
  }
  throw new Error(`Review port ${requestedPort} is unavailable and no nearby fallback port was free.`);
}

async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout.replace(/\r\n/g, "\n");
}

async function runAllowFailure(command: string, args: string[], cwd?: string): Promise<string> {
  try {
    return await run(command, args, cwd);
  } catch {
    return "";
  }
}

async function ghJson<T>(path: string): Promise<T> {
  return JSON.parse(await run("gh", ["api", path])) as T;
}

async function ghJsonPaginatedArray<T>(path: string): Promise<T[]> {
  const output = await run("gh", ["api", path, "--paginate", "--slurp"]);
  const pages = JSON.parse(output) as T[][];
  return pages.flat();
}

function baseSlug(ref: PullRequestRef): string {
  return `${ref.owner}/${ref.repo}`;
}

async function fetchPullRequest(ref: PullRequestRef): Promise<PullRequest> {
  return ghJson<PullRequest>(`/repos/${baseSlug(ref)}/pulls/${ref.number}`);
}

async function fetchPullFiles(ref: PullRequestRef): Promise<PullFile[]> {
  return ghJsonPaginatedArray<PullFile>(`/repos/${baseSlug(ref)}/pulls/${ref.number}/files?per_page=100`);
}

async function fetchPullReviewComments(ref: PullRequestRef): Promise<PullReviewComment[]> {
  return ghJsonPaginatedArray<PullReviewComment>(`/repos/${baseSlug(ref)}/pulls/${ref.number}/comments?per_page=100`);
}

async function ensureLocalCheckout(ref: PullRequestRef, pr: PullRequest, apiOnly: boolean, progress: ProgressSink = () => {}): Promise<LocalCheckout> {
  const host = sanitizePathComponent(ref.host);
  const owner = sanitizePathComponent(pr.base.repo.full_name.split("/")[0] ?? ref.owner);
  const repo = sanitizePathComponent(pr.base.repo.full_name.split("/")[1] ?? ref.repo);
  const cacheDir = resolve(STATE_ROOT, "repos", host, owner, repo);
  const worktreeDir = resolve(STATE_ROOT, "worktrees", host, owner, repo, `pr-${ref.number}`);

  if (apiOnly) {
    progress("API-only mode: skipping local checkout.");
    return { cacheDir: "", worktreeDir: "" };
  }

  await mkdir(resolve(STATE_ROOT, "repos", host, owner), { recursive: true });
  await mkdir(resolve(STATE_ROOT, "worktrees", host, owner, repo), { recursive: true });

  if (!existsSync(resolve(cacheDir, ".git"))) {
    progress(`Cloning base repo ${pr.base.repo.full_name} into ${cacheDir}...`);
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", pr.base.repo.clone_url, cacheDir]);
  } else {
    progress(`Using cached base repo at ${cacheDir}.`);
  }

  progress(`Fetching base ref ${pr.base.ref} and PR ref pull/${ref.number}/head...`);
  await run("git", ["fetch", "origin", "--prune", `+refs/heads/${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`, `+refs/pull/${ref.number}/head:refs/remotes/pi/pr-${ref.number}`], cacheDir);
  progress(`Resetting review worktree ${worktreeDir}...`);
  await runAllowFailure("git", ["worktree", "remove", "--force", worktreeDir], cacheDir);
  await rm(worktreeDir, { recursive: true, force: true });
  progress("Creating detached PR worktree...");
  await run("git", ["worktree", "add", "--force", "--detach", worktreeDir, `refs/remotes/pi/pr-${ref.number}`], cacheDir);

  return { cacheDir, worktreeDir };
}

async function buildSessionData(args: string, progress: ProgressSink = () => {}): Promise<ReviewSessionData> {
  const parsed = parseArgs(args);
  const ref = parsePullRequestUrl(parsed.url);
  progress(`Fetching PR metadata for ${ref.owner}/${ref.repo}#${ref.number}...`);
  const pr = await fetchPullRequest(ref);
  progress(`Fetching changed files for ${pr.base.repo.full_name}#${pr.number}...`);
  const files = await fetchPullFiles(ref);
  progress(`Fetched ${files.length} changed file(s).`);
  progress("Fetching existing review comments...");
  const reviewComments = await fetchPullReviewComments(ref);
  progress(`Fetched ${reviewComments.length} existing review comment(s).`);
  const local = await ensureLocalCheckout(ref, pr, parsed.apiOnly, progress);
  const port = await resolveReviewPort(parsed.port, parsed.explicitPort);
  return {
    ref,
    pr,
    files,
    reviewComments,
    local,
    port,
    url: `http://localhost:${port}/`,
  };
}

function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as T);
      } catch (error) {
        rejectBody(error);
      }
    });
    request.on("error", rejectBody);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function sendSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractMessageText(message: unknown): string {
  const msg = message as { content?: unknown } | null;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    return "";
  }).join("");
}

function normalizeSubmitPayload(payload: SubmitPayload): SubmitPayload {
  const event: ReviewEvent = payload.event === "APPROVE" || payload.event === "REQUEST_CHANGES" ? payload.event : "COMMENT";
  const comments = Array.isArray(payload.comments)
    ? payload.comments
      .filter((comment) => comment != null && typeof comment.path === "string" && typeof comment.body === "string" && comment.body.trim().length > 0)
      .map((comment) => ({
        path: comment.path,
        line: typeof comment.line === "number" ? comment.line : null,
        side: comment.side === "LEFT" ? "LEFT" as const : "RIGHT" as const,
        body: comment.body.trim(),
      }))
    : [];
  return { event, body: typeof payload.body === "string" ? payload.body : "", comments };
}

function buildReviewRequestBody(payload: SubmitPayload): Record<string, unknown> {
  const inlineComments = payload.comments.filter((comment) => comment.line != null).map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
  }));
  const fileComments = payload.comments.filter((comment) => comment.line == null);
  const fileCommentBody = fileComments.length === 0 ? "" : [
    "\n\nFile-level comments drafted in Pi:",
    ...fileComments.map((comment) => `- \`${comment.path}\`: ${comment.body}`),
  ].join("\n");

  return {
    event: payload.event,
    body: `${payload.body.trim()}${fileCommentBody}`.trim(),
    comments: inlineComments,
  };
}

async function submitGitHubReview(data: ReviewSessionData, payload: SubmitPayload): Promise<void> {
  const body = buildReviewRequestBody(payload);
  if (String(body.body ?? "").trim().length === 0 && Array.isArray(body.comments) && body.comments.length === 0) {
    throw new Error("Add a body or at least one inline comment before submitting.");
  }

  const dir = await mkdtemp(resolve(tmpdir(), "pi-pr-review-"));
  const inputPath = resolve(dir, "review.json");
  try {
    await writeFile(inputPath, JSON.stringify(body, null, 2), "utf8");
    await run("gh", ["api", "-X", "POST", `/repos/${baseSlug(data.ref)}/pulls/${data.ref.number}/reviews`, "--input", inputPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildAskPrompt(data: ReviewSessionData, payload: AskPayload): string {
  const file = data.files.find((candidate) => candidate.filename === payload.path);
  return [
    `A browser PR review session asked a line-specific question. Answer in chat with concrete code context.`,
    ``,
    `PR: ${data.pr.html_url}`,
    `Base repo: ${data.pr.base.repo.full_name}`,
    `Base ref/SHA: ${data.pr.base.ref} ${data.pr.base.sha}`,
    `Head SHA: ${data.pr.head.sha}`,
    data.local.worktreeDir ? `Local checkout: ${data.local.worktreeDir}` : `Local checkout: API-only mode; no checkout available.`,
    `File: ${payload.path}`,
    `Side/line: ${payload.side} ${payload.line ?? "file"}`,
    `Question: ${payload.question}`,
    ``,
    file?.patch ? `Diff patch:\n${file.patch}` : `Diff patch unavailable from GitHub for this file.`,
  ].join("\n");
}

async function findGitRepos(root: string): Promise<string[]> {
  const repos: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      repos.push(dir);
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(resolve(dir, entry.name))));
  }
  await visit(root);
  return repos;
}

async function cleanupReviewWorktrees(): Promise<CleanupResult> {
  const worktreesRoot = resolve(STATE_ROOT, "worktrees");
  const reposRoot = resolve(STATE_ROOT, "repos");
  const removedWorktreeRoot = existsSync(worktreesRoot);
  await rm(worktreesRoot, { recursive: true, force: true });

  let prunedRepos = 0;
  for (const repo of await findGitRepos(reposRoot)) {
    await runAllowFailure("git", ["worktree", "prune", "--verbose"], repo);
    prunedRepos += 1;
  }
  return { removedWorktreeRoot, prunedRepos };
}

function getPatchRows(patch: string | undefined): Array<{ kind: string; oldLine: number | null; newLine: number | null; text: string; hunk: string }> {
  if (patch == null) return [];
  const rows: Array<{ kind: string; oldLine: number | null; newLine: number | null; text: string; hunk: string }> = [];
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
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", oldLine: null, newLine, text: line, hunk: currentHunk });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "removed", oldLine, newLine: null, text: line, hunk: currentHunk });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine, newLine, text: line, hunk: currentHunk });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    rows.push({ kind: "meta", oldLine: null, newLine: null, text: line, hunk: currentHunk });
  }
  return rows;
}

function buildStartHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi PR Review</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--muted:#8b949e;--text:#c9d1d9;--accent:#2f81f7;--danger:#f85149}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,sans-serif}.app{min-height:100vh;display:grid;place-items:center;padding:16px}.card{width:min(720px,100%);border:1px solid var(--border);background:var(--panel);border-radius:10px;padding:18px;display:grid;gap:14px}input,button,label{font:inherit}input{width:100%;padding:.75rem;background:#0d1117;color:var(--text);border:1px solid var(--border);border-radius:6px}button{cursor:pointer;padding:.65rem .9rem;border:1px solid var(--accent);background:var(--accent);color:white;border-radius:6px}button.secondary{background:#0d1117;color:var(--text);border-color:var(--border)}button.secondary:hover{border-color:#8b949e}.muted{color:var(--muted);font-size:.9rem}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.error{color:var(--danger);white-space:pre-wrap}.log{display:none;max-height:14rem;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:10px;background:#0d1117;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.84rem;white-space:pre-wrap}.log.active{display:block}</style>
</head>
<body>
<div class="app"><form id="form" class="card"><h1>Pi PR Review</h1><p class="muted">Paste a GitHub PR URL. Pi will cache/check out the base repo and render the diff here. AI questions are sent only when you click Ask Pi.</p><label>PR URL or OWNER/REPO#123<input id="url" autofocus placeholder="https://github.com/pytorch/pytorch/pull/123456"></label><label class="row"><input id="apiOnly" type="checkbox" style="width:auto"> API-only, no local checkout</label><div class="row"><button id="start" type="submit">Start review</button><button id="cleanup" class="secondary" type="button">Clean cached worktrees</button><span class="muted">localhost:${port}</span></div><div><strong>Recent PRs</strong><div id="recent" class="log active"><span class="muted">No recent PRs.</span></div></div><div id="log" class="log"></div><div id="error" class="error"></div></form></div>
<script>
const form=document.getElementById('form');const start=document.getElementById('start');const cleanup=document.getElementById('cleanup');const err=document.getElementById('error');const log=document.getElementById('log');const recent=document.getElementById('recent');
function appendLog(message){log.classList.add('active');log.textContent += (log.textContent ? '\\n' : '') + message; log.scrollTop=log.scrollHeight;}
function renderRecent(){let items=[];try{items=JSON.parse(localStorage.getItem('pi:github-pr-review:history')||'[]')}catch{} recent.innerHTML=items.length?items.map(item=>'<div class="row"><button type="button" data-recent-url="'+item.url+'">Open</button><span>'+item.label+'</span></div>').join(''):'<span class="muted">No recent PRs.</span>'}
recent.addEventListener('click', e=>{const b=e.target.closest('[data-recent-url]'); if(!b)return; document.getElementById('url').value=b.dataset.recentUrl; form.requestSubmit();});
renderRecent();
cleanup.addEventListener('click',async()=>{if(!confirm('Remove cached PR worktree directories and prune git worktree metadata?'))return;err.textContent='';cleanup.disabled=true;cleanup.textContent='Cleaning…';try{const r=await fetch('/api/cleanup-worktrees',{method:'POST'});if(!r.ok)throw new Error(await r.text());const result=await r.json();appendLog('Cleaned cached worktrees. Removed worktree root: '+result.removedWorktreeRoot+'. Pruned repos: '+result.prunedRepos+'.');}catch(error){err.textContent=String(error.message||error);}finally{cleanup.disabled=false;cleanup.textContent='Clean cached worktrees';}});
form.addEventListener('submit',async(e)=>{e.preventDefault();err.textContent='';log.textContent='';log.classList.add('active');start.disabled=true;start.textContent='Starting…';const r=await fetch('/api/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:document.getElementById('url').value,apiOnly:document.getElementById('apiOnly').checked})});if(!r.ok){err.textContent=await r.text();start.disabled=false;start.textContent='Start review';return;}const reader=r.body.getReader();const decoder=new TextDecoder();let buffer='';try{while(true){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});const lines=buffer.split('\\n');buffer=lines.pop()||'';for(const line of lines){if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='progress')appendLog(event.message);if(event.type==='ready'){document.open();document.write(event.html);document.close();return;}if(event.type==='error')throw new Error(event.message);}}}catch(error){err.textContent=String(error.message||error);start.disabled=false;start.textContent='Start review';}});
</script>
</body>
</html>`;
}

function buildAppHtml(data: ReviewSessionData): string {
  const sessionJson = escapeInlineJson(JSON.stringify({
    pr: data.pr,
    files: data.files,
    rowsByPath: Object.fromEntries(data.files.map((file) => [file.filename, getPatchRows(file.patch)])),
    reviewComments: data.reviewComments,
    local: data.local,
  }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi PR Review</title>
<style>
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--muted:#8b949e;--text:#c9d1d9;--accent:#2f81f7;--danger:#f85149;--ok:#3fb950;--add:rgba(46,160,67,.18);--del:rgba(248,81,73,.16)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,sans-serif}button,textarea,select,input{font:inherit;color:inherit;background:#0d1117;border:1px solid var(--border);border-radius:6px}button{cursor:pointer;padding:.45rem .7rem}button:hover{border-color:#8b949e}.app{display:grid;grid-template-rows:auto 1fr;gap:12px;min-height:100vh;padding:14px}.toolbar,.panel,.file{border:1px solid var(--border);background:var(--panel);border-radius:8px}.toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 14px;flex-wrap:wrap}.title{display:grid;gap:4px}.muted{color:var(--muted);font-size:.86rem}.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:12px;align-items:start}.files{display:grid;gap:10px;align-content:start}.file summary{cursor:pointer;padding:12px 14px}.file-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:5px}.pill{border:1px solid var(--border);border-radius:999px;padding:.1rem .45rem;color:var(--muted);font-size:.78rem}.patch{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;line-height:1.45;border-top:1px solid var(--border);overflow:auto}.row{display:grid;grid-template-columns:54px 54px 1fr;gap:8px;padding:0 8px;white-space:pre}.row[data-target]{cursor:pointer}.row:hover{background:rgba(177,186,196,.08)}.num{color:#6e7681;text-align:right}.added{background:var(--add)}.removed{background:var(--del)}.hunk{color:#79c0ff;background:#0d1117}.meta{color:var(--muted)}.inline-draft{margin:.55rem 8px .8rem;padding:.75rem;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:8px;background:rgba(47,129,247,.08);display:grid;gap:8px;white-space:normal}.inline-comment{border-left-color:#56d364;background:rgba(46,160,67,.10)}.existing-comment{border-left-color:#d29922;background:rgba(210,153,34,.10)}.inline-draft textarea{min-height:5rem;background:rgba(13,17,23,.8)}.thread-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.thread-msg{border-top:1px solid var(--border);padding-top:.55rem}.thread-msg pre{margin:.25rem 0 0;white-space:pre-wrap;font-family:inherit}.thread-input{display:grid;gap:8px}.side{position:sticky;top:14px;max-height:calc(100vh - 28px);padding:12px;display:grid;gap:12px;align-content:start;overflow:auto}.card{border:1px solid var(--border);border-radius:8px;padding:10px;display:grid;gap:8px;background:#0d1117}textarea{width:100%;min-height:6rem;padding:.6rem;resize:vertical}.actions{display:flex;gap:8px;flex-wrap:wrap}.primary{background:var(--accent);border-color:var(--accent);color:white}.danger{color:var(--danger)}.ok{color:#56d364}.drafts{display:grid;gap:8px;max-height:35vh;overflow:auto}.draft-target{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--muted)}@media(max-width:1100px){.layout{grid-template-columns:1fr}.side{position:static;max-height:none;order:-1}}
</style>
</head>
<body>
<div class="app">
  <div class="toolbar"><div class="title"><strong>Pi PR Review</strong><span class="muted">${escapeHtml(data.pr.base.repo.full_name)}#${data.pr.number} · ${escapeHtml(data.pr.title)}</span><span class="muted">Local checkout: ${escapeHtml(data.local.worktreeDir || "API-only")}</span></div><div class="actions"><a href="${escapeHtml(data.pr.html_url)}" target="_blank"><button>Open GitHub</button></a><button id="cancel" class="danger">Close</button></div></div>
  <div class="layout"><main id="files" class="files"></main><aside class="panel side"><div class="card"><strong>Draft review</strong><label class="muted">Final action</label><select id="event"><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select><label class="muted">Review body</label><textarea id="body" placeholder="Overall review body"></textarea><div class="actions"><button id="submit" class="primary">Submit to GitHub</button></div></div><div class="card"><strong>Draft comments</strong><div id="drafts" class="drafts"><span class="muted">No draft comments.</span></div></div><div class="card"><strong>Existing comments</strong><div id="existing" class="drafts"><span class="muted">No existing comments.</span></div></div></aside></div>
</div>
<script id="session" type="application/json">${sessionJson}</script>
<script>
const session = JSON.parse(document.getElementById('session').textContent || '{}');
const filesEl = document.getElementById('files');
const draftsEl = document.getElementById('drafts');
const existingEl = document.getElementById('existing');
const eventEl = document.getElementById('event');
const bodyEl = document.getElementById('body');
const storageKey = 'pi:github-pr-review:' + session.pr.html_url;
const drafts = [];
const threads = new Map();
const questionThreads = new Map();
let activeThreadKey = null;
function esc(v){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function attr(v){return esc(JSON.stringify(v))}
function id(){return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()}
function targetText(c){return c.path + ' · ' + c.side + ' ' + (c.line == null ? 'file' : c.line)}
function targetKey(c){return c.path + ':' + c.side + ':' + (c.line == null ? 'file' : c.line)}
function existingTarget(c){return {path:c.path,line:c.line ?? c.original_line ?? null,side:c.side || c.original_side || 'RIGHT'}}
function existingAuthor(c){return c.user?.login || 'unknown'}
function saveState(){try{localStorage.setItem(storageKey,JSON.stringify({drafts,body:bodyEl.value,event:eventEl.value,threads:[...threads.values()]}))}catch{}}
function loadState(){try{const raw=localStorage.getItem(storageKey); if(!raw)return; const state=JSON.parse(raw); if(Array.isArray(state.drafts)) drafts.push(...state.drafts); if(typeof state.body==='string') bodyEl.value=state.body; if(typeof state.event==='string') eventEl.value=state.event; if(Array.isArray(state.threads)){for(const t of state.threads){if(t&&t.key&&t.target) threads.set(t.key,{...t,input:t.input||'',messages:Array.isArray(t.messages)?t.messages:[]})}}}catch{}}
function renderDrafts(){draftsEl.innerHTML = drafts.length ? drafts.map(c => '<div class="card"><div class="draft-target">'+esc(targetText(c))+'</div><div>'+esc(c.body)+'</div><div class="actions"><button data-remove="'+esc(c.id)+'" class="danger">Remove</button></div></div>').join('') : '<span class="muted">No draft comments.</span>'; saveState()}
function renderExistingComments(){const comments=session.reviewComments||[]; existingEl.innerHTML = comments.length ? comments.map(c => '<div class="card"><div class="draft-target">'+esc(existingAuthor(c)+' · '+targetText(existingTarget(c)))+'</div><div>'+esc(c.body)+'</div><div class="actions"><a href="'+esc(c.html_url)+'" target="_blank"><button>Open</button></a></div></div>').join('') : '<span class="muted">No existing comments.</span>'}
function draftsForTarget(target){return drafts.filter(c => targetKey(c) === targetKey(target))}
function existingForTarget(target){return (session.reviewComments||[]).filter(c => targetKey(existingTarget(c)) === targetKey(target))}
function renderInlineDrafts(target){const matching=draftsForTarget(target); if(!matching.length)return ''; return matching.map(c => '<div class="inline-draft inline-comment"><div class="thread-head"><div class="draft-target">Draft comment · '+esc(targetText(c))+'</div><button class="danger" data-remove="'+esc(c.id)+'">Remove</button></div><pre>'+esc(c.body)+'</pre></div>').join('')}
function renderInlineExisting(target){const matching=existingForTarget(target); if(!matching.length)return ''; return matching.map(c => '<div class="inline-draft existing-comment"><div class="thread-head"><div class="draft-target">Existing comment · '+esc(existingAuthor(c))+' · '+esc(targetText(existingTarget(c)))+'</div><a href="'+esc(c.html_url)+'" target="_blank"><button>Open</button></a></div><pre>'+esc(c.body)+'</pre></div>').join('')}
function ensureThread(target){const key=targetKey(target); let thread=threads.get(key); if(!thread){thread={key,target,collapsed:false,input:'',messages:[]}; threads.set(key,thread);} return thread}
function setTarget(target){const thread=ensureThread(target); thread.collapsed=false; activeThreadKey=thread.key; renderFiles(); queueMicrotask(()=>{const el=document.querySelector('[data-thread-input="'+CSS.escape(thread.key)+'"]'); if(el) el.focus();})}
function addDraftFromThread(key){const thread=threads.get(key); if(!thread || !thread.input.trim()) return; drafts.push({id:id(),path:thread.target.path,line:thread.target.line,side:thread.target.side,body:thread.input.trim()}); thread.input=''; renderFiles(); renderDrafts(); saveState()}
function addMessageDraft(key,index){const thread=threads.get(key); const msg=thread?.messages?.[Number(index)]; if(!thread||!msg||!msg.text)return; drafts.push({id:id(),path:thread.target.path,line:thread.target.line,side:thread.target.side,body:msg.text.trim()}); renderFiles(); renderDrafts(); saveState()}
async function askPiFromThread(key){const thread=threads.get(key); if(!thread || !thread.input.trim()) return; const question=thread.input.trim(); const message={role:'user',text:question}; thread.messages.push(message); thread.input=''; renderFiles(); const r=await fetch('/api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...thread.target,threadKey:key,question})}); if(!r.ok){thread.messages.push({role:'assistant',text:'Send failed: '+await r.text(),status:'error'}); renderFiles(); return;} const payload=await r.json(); questionThreads.set(payload.id,key); thread.messages.push({role:'assistant',text:'',status:'Queued in Pi…',id:payload.id}); renderFiles()}
function renderThread(thread){const inlineDrafts=renderInlineExisting(thread.target)+renderInlineDrafts(thread.target); if(thread.collapsed){return inlineDrafts+'<div class="inline-draft"><div class="thread-head"><button data-inline-action="expand" data-thread-key="'+esc(thread.key)+'">▶ '+esc(targetText(thread.target))+' · '+thread.messages.length+' messages</button></div></div>'} const messages=thread.messages.map((m,i) => '<div class="thread-msg"><strong>'+esc(m.role==='user'?'You':'Pi')+':</strong><pre>'+esc(m.text || m.status || '')+'</pre>'+(m.role==='assistant'&&m.text?'<div class="actions"><button data-inline-action="draft-message" data-thread-key="'+esc(thread.key)+'" data-message-index="'+i+'">Draft this</button></div>':'')+'</div>').join(''); return inlineDrafts+'<div class="inline-draft"><div class="thread-head"><div class="draft-target">'+esc(targetText(thread.target))+'</div><button data-inline-action="collapse" data-thread-key="'+esc(thread.key)+'">Collapse</button></div>'+messages+'<div class="thread-input"><textarea data-thread-input="'+esc(thread.key)+'" placeholder="Ask a follow-up or draft a GitHub comment">'+esc(thread.input)+'</textarea><div class="actions"><button class="primary" data-inline-action="ask" data-thread-key="'+esc(thread.key)+'">Ask Pi</button><button data-inline-action="draft" data-thread-key="'+esc(thread.key)+'">Add draft comment</button></div></div></div>'}
function renderFiles(){filesEl.innerHTML = session.files.map(f => { const rows = session.rowsByPath[f.filename] || []; const patch = rows.length ? rows.map(r => { const side = r.newLine != null ? 'RIGHT' : 'LEFT'; const line = r.newLine != null ? r.newLine : r.oldLine; const canTarget = line != null && r.kind !== 'hunk' && r.kind !== 'meta'; const target = canTarget ? {path:f.filename,line,side,hunk:r.hunk} : null; const key = target ? targetKey(target) : null; const thread = key ? threads.get(key) : null; const inlineDrafts = target && !thread ? renderInlineExisting(target)+renderInlineDrafts(target) : ''; const count = (thread ? thread.messages.length : 0) + (target ? draftsForTarget(target).length + existingForTarget(target).length : 0); const countPill = count ? ' <span class="pill">'+count+'</span>' : ''; const row = '<div class="row '+esc(r.kind)+'" '+(target ? 'data-target="'+attr(target)+'" title="Click to start or expand thread"' : '')+'><span class="num">'+(r.oldLine ?? '')+'</span><span class="num">'+(r.newLine ?? '')+'</span><span>'+esc(r.text)+countPill+'</span></div>'; return row + (thread ? renderThread(thread) : inlineDrafts); }).join('') : '<div class="row meta" data-target="'+attr({path:f.filename,line:null,side:'RIGHT',hunk:''})+'"><span></span><span></span><span>Patch unavailable, likely binary or too large. Click to comment or ask Pi.</span></div>'; return '<details class="file" open><summary><strong>'+esc(f.filename)+'</strong><div class="file-meta"><span class="pill">'+esc(f.status)+'</span><span class="pill">+'+f.additions+' / -'+f.deletions+'</span></div></summary><div class="patch">'+patch+'</div></details>'; }).join('')}
filesEl.addEventListener('click', e => { const remove=e.target.closest('[data-remove]'); if(remove){removeDraftById(remove.dataset.remove); return;} const action=e.target.closest('[data-inline-action]'); if(action){ const key=action.dataset.threadKey; if(action.dataset.inlineAction==='ask') void askPiFromThread(key); else if(action.dataset.inlineAction==='draft') addDraftFromThread(key); else if(action.dataset.inlineAction==='draft-message') addMessageDraft(key, action.dataset.messageIndex); else if(action.dataset.inlineAction==='collapse'){const t=threads.get(key); if(t)t.collapsed=true; renderFiles(); saveState();} else if(action.dataset.inlineAction==='expand'){const t=threads.get(key); if(t)t.collapsed=false; renderFiles(); saveState();} return; } const row=e.target.closest('[data-target]'); if(!row) return; setTarget(JSON.parse(row.dataset.target)); });
filesEl.addEventListener('input', e => { const key=e.target?.dataset?.threadInput; if(key && threads.has(key)){threads.get(key).input=e.target.value; saveState();} });
const events = new EventSource('/api/events');
events.addEventListener('pi-answer-start', e => { const p=JSON.parse(e.data); if(p.threadKey) questionThreads.set(p.id,p.threadKey); const t=threads.get(questionThreads.get(p.id)); if(t){const m=t.messages.find(m=>m.id===p.id); if(m)m.status='Thinking…'; renderFiles(); saveState();} });
events.addEventListener('pi-answer-delta', e => { const p=JSON.parse(e.data); if(p.threadKey) questionThreads.set(p.id,p.threadKey); const t=threads.get(questionThreads.get(p.id)); if(t){const m=t.messages.find(m=>m.id===p.id); if(m && p.text){m.text=p.text; m.status='';} renderFiles(); saveState();} });
events.addEventListener('pi-answer-end', e => { const p=JSON.parse(e.data); const t=threads.get(questionThreads.get(p.id)); if(t){const m=t.messages.find(m=>m.id===p.id); if(m){if(p.text){m.text=p.text; m.status='';} else if(!m.text){m.status='Pi used tools or produced no stream yet; waiting for the final answer…';}} renderFiles(); saveState();} });
function removeDraftById(id){const i=drafts.findIndex(c=>c.id===id); if(i>=0) drafts.splice(i,1); renderFiles(); renderDrafts(); saveState();}
draftsEl.addEventListener('click', e => { const b=e.target.closest('[data-remove]'); if(!b) return; removeDraftById(b.dataset.remove); });
bodyEl.addEventListener('input', saveState); eventEl.addEventListener('change', saveState);
document.getElementById('submit').addEventListener('click', async () => { if(!confirm('Submit this review to GitHub?')) return; const r=await fetch('/api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event:eventEl.value,body:bodyEl.value,comments:drafts})}); if(!r.ok){alert(await r.text()); return;} localStorage.removeItem(storageKey); document.body.innerHTML='<div class="app"><div class="toolbar"><strong class="ok">Submitted review to GitHub.</strong></div></div>' });
document.getElementById('cancel').addEventListener('click', async () => { await fetch('/api/cancel',{method:'POST'}); document.body.innerHTML='<div class="app"><div class="toolbar"><strong>Closed PR review server.</strong></div></div>' });
loadState(); renderFiles(); renderDrafts(); renderExistingComments();
</script>
</body>
</html>`;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function showReviewLinkWidget(ctx: ExtensionCommandContext, url: string): void {
  ctx.ui.setWidget("github-pr-review", [
    `GitHub PR review: ${url}`,
    "Paste a PR link in the browser to start; Ask Pi answers stream back into the page.",
  ]);
}

async function openReviewServer(pi: ExtensionAPI, initialData: ReviewSessionData | null, port: number, activeSessions: Set<ActiveSession>): Promise<ActiveSession> {
  return new Promise((resolveSession, rejectSession) => {
    let active: ActiveSession;
    let data = initialData;
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && url.pathname === "/") {
          sendHtml(response, data == null ? buildStartHtml(port) : buildAppHtml(data));
          return;
        }
        if (request.method === "GET" && url.pathname === "/favicon.ico") {
          response.writeHead(204); response.end(); return;
        }
        if (request.method === "POST" && url.pathname === "/api/cleanup-worktrees") {
          if (data != null) {
            response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
            response.end("Close the active PR review before cleaning cached worktrees.");
            return;
          }
          sendJson(response, 200, await cleanupReviewWorktrees());
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/start") {
          if (data != null) {
            sendJson(response, 409, { error: "This PR review server already has an active PR." });
            return;
          }
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" });
          const emit = (event: unknown) => response.write(`${JSON.stringify(event)}\n`);
          try {
            const payload = await readJsonBody<{ url?: string; apiOnly?: boolean }>(request);
            const startArgs = `${payload.apiOnly ? "--api-only " : ""}--port=${port} ${payload.url ?? ""}`;
            data = await buildSessionData(startArgs, (message) => emit({ type: "progress", message }));
            active.ref = data.ref;
            emit({ type: "progress", message: "Rendering browser review UI..." });
            emit({ type: "ready", html: buildAppHtml(data) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emit({ type: "error", message });
          }
          response.end();
          return;
        }
        if (data == null) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("Start a PR review first.");
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/events") {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          });
          response.write(": connected\n\n");
          active.eventClients.add(response);
          request.on("close", () => active.eventClients.delete(response));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/ask") {
          const payload = await readJsonBody<AskPayload>(request);
          const questionId = randomUUID();
          const threadKey = typeof payload.threadKey === "string" ? payload.threadKey : null;
          active.activeQuestions.set(questionId, { threadKey, lastAssistantText: "" });
          for (const client of active.eventClients) sendSse(client, "pi-answer-start", { id: questionId, threadKey });
          await pi.sendUserMessage(`${buildAskPrompt(data, payload)}\n\nQuestion id: ${questionId}`, { deliverAs: "followUp" });
          sendJson(response, 200, { ok: true, id: questionId });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/submit") {
          const payload = normalizeSubmitPayload(await readJsonBody<SubmitPayload>(request));
          await submitGitHubReview(data, payload);
          sendJson(response, 200, { ok: true });
          activeSessions.delete(active);
          await closeServer(server);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/cancel") {
          sendJson(response, 200, { ok: true });
          activeSessions.delete(active);
          await closeServer(server);
          return;
        }
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found.");
      } catch (error) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(message);
      }
    });

    active = { server, url: `http://localhost:${port}/`, ref: data?.ref, eventClients: new Set(), activeQuestions: new Map() };
    server.once("error", rejectSession);
    server.listen(port, "127.0.0.1", () => {
      activeSessions.add(active);
      resolveSession(active);
    });
  });
}

export default function (pi: ExtensionAPI) {
  const activeSessions = new Set<ActiveSession>();

  pi.on("message_update", async (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role !== "assistant") return;
    const text = extractMessageText(message);
    if (text.length === 0) return;
    for (const session of activeSessions) {
      if (session.activeQuestions.size === 0 || session.eventClients.size === 0) continue;
      for (const [id, question] of session.activeQuestions) {
        question.lastAssistantText = text;
        for (const client of session.eventClients) sendSse(client, "pi-answer-delta", { id, threadKey: question.threadKey, text });
      }
    }
  });

  pi.on("message_end", async (event) => {
    const message = (event as { message?: { role?: string; stopReason?: string } }).message;
    if (message?.role !== "assistant") return;
    const text = extractMessageText(message);
    const hasFinalText = text.length > 0;
    const isToolUseTurn = message.stopReason === "toolUse";
    for (const session of activeSessions) {
      if (session.activeQuestions.size === 0 || session.eventClients.size === 0) continue;
      if (!hasFinalText && isToolUseTurn) continue;
      const completedIds: string[] = [];
      for (const [id, question] of session.activeQuestions) {
        const finalText = hasFinalText ? text : question.lastAssistantText;
        for (const client of session.eventClients) sendSse(client, "pi-answer-end", { id, threadKey: question.threadKey, text: finalText });
        completedIds.push(id);
      }
      for (const id of completedIds) session.activeQuestions.delete(id);
    }
  });

  pi.registerCommand("pr-review", {
    description: "Open a browser GitHub PR review app with cached base-repo checkout and GH review submission",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const parsed = parseArgs(args);
        const hasUrl = parsed.url.trim().length > 0;
        const port = hasUrl ? parsed.port : await resolveReviewPort(parsed.port, parsed.explicitPort);
        const data = hasUrl ? await buildSessionData(args) : null;
        if (data != null) {
          const existing = [...activeSessions].find((session) => session.ref != null && session.ref.host === data.ref.host && session.ref.owner === data.ref.owner && session.ref.repo === data.ref.repo && session.ref.number === data.ref.number);
          if (existing != null) {
            ctx.ui.notify(`PR review already running at ${existing.url}`, "warning");
            return;
          }
        }
        const session = await openReviewServer(pi, data, data?.port ?? port, activeSessions);
        showReviewLinkWidget(ctx, session.url);
        ctx.ui.notify(`PR review ready: ${session.url}`, "info");
        if (data == null) {
          ctx.ui.notify("Open the URL and paste a GitHub PR link to start.", "info");
          return;
        }
        if (data.local.worktreeDir) ctx.ui.notify(`Checked out PR in ${data.local.worktreeDir}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`PR review failed: ${message}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...activeSessions].map(async (session) => {
      activeSessions.delete(session);
      await closeServer(session.server);
    }));
  });
}
