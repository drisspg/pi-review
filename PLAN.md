# Pi PR Review SDK App Plan

## Motivation

The current `github-pr-review.ts` Pi extension started as a small browser helper for PR review, but it has grown into a stateful product UI. The extension approach is now fighting the requirements:

- Rich inline diff UI with collapsible sections and editable comments.
- Persistent viewed-file state across re-reviews.
- PR history and ability to reopen previous review sessions.
- Existing GitHub review comments fetched and displayed inline.
- Reliable Ask Pi request/response routing back to the exact browser thread.
- Cleaner UX similar to the local `/diff-review` flow.

This should likely become a standalone local web app/server that uses the Pi SDK directly, with the existing Pi extension reduced to a launcher.

## Proposed Architecture

Create a new local project, e.g.

```text
pi-pr-review/
  package.json
  src/
    server.ts           # local HTTP/WebSocket server
    github.ts           # gh/GitHub API wrapper
    worktrees.ts        # base repo cache + PR worktree management
    pi-session.ts       # Pi SDK AgentSession wrapper
    state.ts            # persistent review state
  web/
    src/                # React/Svelte/Vite UI
```

High-level flow:

```text
/pr-review or CLI
  -> starts/opens local pi-pr-review server
  -> user picks/reopens PR
  -> app fetches PR files/comments via GitHub
  -> app prepares local PR worktree
  -> app creates/uses Pi SDK AgentSession scoped to the worktree
  -> browser asks line-specific questions over WebSocket/SSE
  -> SDK streams assistant events directly back to that browser request id
```

## Why SDK Instead of Extension/RPC

Use Pi SDK directly because the app is Node/TypeScript and wants tight control:

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  cwd: prWorktreeDir,
  sessionManager: SessionManager.create(prWorktreeDir),
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // stream to browser by exact question id
  }
});

await session.prompt(promptForLineQuestion);
```

SDK advantages:

- No global `message_update` guessing from a Pi extension.
- Direct per-request routing: browser question id -> SDK prompt -> streamed answer.
- Real application state and UI framework.
- Reuses Pi auth/config/models/tools when desired.
- Easier testing than HTML-in-template-string extension code.

RPC mode is a fallback if process isolation or non-Node clients become important, but SDK is the cleaner first implementation.

## Core Features

### 1. PR Start / History Page

- Paste PR URL or `OWNER/REPO#123`.
- Show recent PRs from persistent state.
- Click a previous PR to reopen its review session.
- Show metadata:
  - repo
  - PR number/title
  - base/head SHA
  - last reviewed SHA
  - number of files changed
  - existing comment count

### 2. Worktree Cache Management

- Cache base repos under app state, similar to current extension:

```text
~/.pi/agent/state/github-pr-review/repos/<host>/<owner>/<repo>
~/.pi/agent/state/github-pr-review/worktrees/<host>/<owner>/<repo>/pr-<number>
```

- Reuse base repo cache.
- Reset PR worktree on each open.
- Add explicit cleanup UI:
  - prune stale Git worktree metadata
  - remove old PR worktrees
  - optionally clear all cached repos

### 3. Diff UI Mirroring `/diff-review`

Implement a richer diff UI rather than line-by-line always-expanded widgets:

- Files render as sections with summary header.
- File can be marked viewed/unviewed.
- Viewed state persists by `(PR URL, file path, file fingerprint/head SHA)`.
- On re-review:
  - unchanged + previously viewed files start collapsed
  - changed/new files start expanded
- Hidden unchanged/context sections can be expanded with buttons, like `/diff-review`.
- Clicking a row toggles the inline thread/editor instead of permanently opening it.
- Inline thread is attached below the diff row and can collapse back to a compact pill.

### 4. Draft Comments

- Draft comments remain inline under their target line.
- Draft comments also appear in the sticky right sidebar.
- Draft comments can be edited inline.
- Draft comments can be removed from either inline view or sidebar.
- Support file-level draft comments.
- Save drafts to persistent state, not only browser localStorage.

Suggested state shape:

```ts
type DraftComment = {
  id: string;
  prKey: string;
  path: string;
  line: number | null;
  side: "RIGHT" | "LEFT";
  body: string;
  createdAt: string;
  updatedAt: string;
};
```

### 5. Existing GitHub Comments

Fetch existing PR review comments from:

```text
GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
```

Display:

- inline under mapped diff rows when possible
- in the right sidebar
- with author, timestamp, and GitHub link

Mapping policy:

- Prefer `line` + `side` for current diff position.
- Fallback to `original_line` + `original_side` for older comments.
- If line cannot be mapped to current rendered diff, show in sidebar under “unmapped existing comments”.

### 6. Ask Pi Threads

Line-specific Ask Pi should be app-native:

- Browser creates a question id.
- Server creates/uses an SDK `AgentSession` for the PR/worktree.
- Server sends a prompt with PR/file/hunk context.
- Server streams SDK `message_update` text deltas back to that exact question id.
- Server sends final `message_end` for that exact question id.

Avoid the current extension behavior where global message events are broadcast to all active questions.

Thread state:

```ts
type AskThread = {
  id: string;
  prKey: string;
  target: { path: string; line: number | null; side: "RIGHT" | "LEFT" };
  messages: Array<{ role: "user" | "pi"; text: string; createdAt: string }>;
  collapsed: boolean;
};
```

### 7. Submitting Review

Use GitHub review API:

```text
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

Payload:

```json
{
  "event": "COMMENT|APPROVE|REQUEST_CHANGES",
  "body": "overall body",
  "comments": [
    { "path": "file.py", "line": 123, "side": "RIGHT", "body": "..." }
  ]
}
```

After successful submit:

- clear submitted drafts
- update existing comments by refetching comments
- mark review timestamp/head SHA

## Persistence

Use SQLite or a JSON file store. SQLite is preferred once the state grows.

Minimum persistent entities:

- `prs`: PR URL, repo, number, title, base/head SHA, last opened, last reviewed head SHA.
- `file_reviews`: PR key, path, file fingerprint/head SHA, viewed bool.
- `draft_comments`: editable drafts.
- `ask_threads`: Pi conversations attached to diff targets.
- `settings`: cleanup thresholds, default model/thinking, browser preference.

Initial implementation can start with a single JSON file:

```text
~/.pi/agent/state/pi-pr-review/state.json
```

## Relationship to Current Pi Extension

Keep a small Pi extension only as a launcher:

- `/pr-review` starts or opens the local app.
- Optional args pass an initial PR URL.
- The extension should not own review state, render the full UI, or proxy Pi answers.

Possible launcher behavior:

```text
/pr-review https://github.com/pytorch/pytorch/pull/175472
  -> ensure app server running
  -> open http://localhost:<port>/pr?url=...
```

## Implementation Phases

### Phase 0: Stopgap cleanup

- Do not keep adding large UX features to `github-pr-review.ts`.
- Keep current extension functional enough as a bridge.
- Optionally revert partial UI experiments if they make the extension brittle.

### Phase 1: Scaffold standalone app

- Create new project under `~/meta/pi-pr-review` or similar.
- Add TypeScript server and Vite frontend.
- Implement start page, PR URL parsing, and GitHub metadata fetch.
- Add PR history persistence.

### Phase 2: GitHub + worktree backend

- Fetch PR files and comments.
- Cache base repo and create PR worktree.
- Add cleanup API and UI.

### Phase 3: Diff viewer MVP

- Render changed files and hunks.
- Inline add/edit/remove draft comments.
- Sticky sidebar with drafts/existing comments.
- Submit review to GitHub.

### Phase 4: Viewed/re-review UX

- Persist viewed file state.
- Store file fingerprints/head SHA.
- Collapse already-viewed unchanged files on reopen.
- Expand changed/new files.
- Add hidden context expansion controls.

### Phase 5: Pi SDK integration

- Create SDK session scoped to PR worktree.
- Implement Ask Pi per line/file.
- Stream responses over WebSocket/SSE by question id.
- Persist ask threads.

### Phase 6: Launcher extension

- Replace current heavy `/pr-review` with a small launcher.
- It starts app server if needed and opens browser URL.
- Keep cleanup and state in the standalone app.

## Open Questions

- Frontend framework: React/Vite vs Svelte vs plain TS. React/Vite is probably easiest for UI state.
- Persistence: JSON first or SQLite immediately.
- Should each PR have a dedicated Pi session file, or should sessions be ephemeral per question?
  - Recommendation: one persistent SDK session per PR/worktree, so follow-up questions have context.
- Should app use default Pi resource discovery or a custom ResourceLoader?
  - Recommendation: start with default discovery so existing tools/skills/config work.
- How to detect changed files since last review?
  - Store last reviewed head SHA and compare current PR file patches/fingerprints.

## Success Criteria

- Reopening a PR restores drafts, viewed files, and ask threads.
- Existing GitHub comments show inline and in sidebar.
- Ask Pi answers always stream back to the exact browser thread that requested them.
- Viewed unchanged files collapse by default on re-review.
- Changed files expand by default.
- Draft comments are editable inline before submission.
- The Pi extension is small and reliable: it only launches the app.
