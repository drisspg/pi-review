# pi-review

Standalone Pi SDK-backed GitHub PR review app seed.

This folder starts from the previous Pi extension prototype in `reference/` and the SDK app migration plan in `PLAN.md`.

Goal: replace the heavyweight `github-pr-review.ts` Pi extension with a real local web app/server that uses the Pi SDK directly for Ask Pi threads, persistent PR review state, viewed files, existing GitHub comments, and editable inline drafts.

## Current scaffold

- TypeScript HTTP API server in `src/`.
- React/Vite start page in `web/src/`.
- PR URL parsing for `https://github.com/OWNER/REPO/pull/123` and `OWNER/REPO#123`.
- GitHub metadata fetch through `gh api`.
- Persistent recent PR history in `~/.pi/agent/state/pi-pr-review/state.json`.

## Commands

```sh
npm install
npm run dev
npm run build
npm start
```

Open http://127.0.0.1:5173 in dev mode or http://127.0.0.1:43133 after `npm run build && npm start`.
