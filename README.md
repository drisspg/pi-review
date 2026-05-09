# pi-review

Standalone Pi SDK-backed GitHub PR review app.

This project replaces the heavyweight `github-pr-review.ts` Pi extension prototype in `reference/` with a local web app/server that owns PR review state, renders a GitHub-style diff UI, and uses the Pi SDK for inline Ask Pi threads.

## Features

- Open PRs from `https://github.com/OWNER/REPO/pull/123` or `OWNER/REPO#123`.
- Fetch PR metadata, files, and existing review comments with `gh api`.
- Render GitHub-style file diffs with inline threads.
- Expand neighboring context lines above/below hunks.
- Add, edit, remove, and bulk-submit draft review comments.
- Support multiline draft ranges.
- Mark files viewed; unchanged viewed files reopen collapsed.
- Track previous PRs in local state.
- Prepare cached PR worktrees and scope Pi SDK sessions to the PR worktree.
- Persist/reuse Pi sessions per PR across page reloads and server restarts.
- Render Pi responses as Markdown with syntax-highlighted code blocks.

## Requirements

- Node.js/npm
- `gh` authenticated for GitHub API access
- `git`
- Pi SDK auth/config already set up for Ask Pi

Check GitHub auth:

```sh
gh auth status
```

## Quick start

From a fresh clone, one command installs dependencies, builds the app, and starts the local server:

```sh
npm start
```

Open http://127.0.0.1:43133.

Or clone and start in one shell command:

```sh
git clone https://github.com/drisspg/pi-review && cd pi-review && npm start
```

`npm start` automatically runs `npm install` when dependencies are missing or stale, runs `npm run build` when the built server/web assets are missing or stale, then starts the production server.

## Commands

Run dev mode with file watching:

```sh
npm run dev
```

Open http://127.0.0.1:5173.

Build only:

```sh
npm run build
```

Run an already-built production server without install/build checks:

```sh
npm run start:built
```

Validation loop:

```sh
npm run validate
```

Individual checks:

```sh
npm run typecheck
npm run build
npm run test:e2e
```

The Playwright suite opens a real PR by default. Override it with:

```sh
PI_REVIEW_TEST_PR=https://github.com/OWNER/REPO/pull/123 npm run test:e2e
```

## Local state

State is stored under:

```text
~/.pi/agent/state/pi-pr-review/
```

Important subdirectories:

```text
state.json                 # recent PRs and viewed file state
repos/                     # cached base repos
worktrees/                 # per-PR worktrees
pi-sessions/               # persistent Pi SDK sessions per PR
```

## Development notes

- The backend lives in `src/`.
- The React/Vite UI lives in `web/src/`.
- The migration plan is in `PLAN.md`.
- The old extension prototype is kept in `reference/` for behavior reference.
