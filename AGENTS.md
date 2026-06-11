# Pi Review Agent Guidance

## Backend-first feature workflow

When implementing or prototyping a new Pi Review feature, prove the behavior through the backend contract before relying on the frontend.

- Put durable feature behavior in an injectable `src/*-api.ts` module with focused unit tests.
- Keep `src/server.ts` as dependency wiring and lifecycle only; route dispatch belongs in `src/server-router.ts` or a feature API module.
- Add or extend typed backend contracts before wiring UI text/protocols into React. Use `/api/pi/prompt` modes for durable agent prompts instead of constructing long prompts in the frontend.
- For “test this PR” or “have an agent try this out” flows, use the `test-pr` prompt contract via `/api/pi/prompt` with `{ mode: "test-pr", prKey, testIntent, files?, gpuRequired? }`.
- Validate backend behavior from the CLI first: targeted unit tests, direct module calls, local HTTP requests, or command-line repros against the checked-out PR/worktree.
- Only move to frontend/browser checks after the backend behavior is proven, or when the change is specifically UI wiring/interaction.

## Validation expectations

- Run the most relevant targeted unit tests for the changed backend contract.
- Run `npm run typecheck` and `npm run build` before handoff.
- Run `npm run test:e2e` or targeted Playwright tests when frontend/server wiring changes materially.
- The full `pr-review` e2e suite passes on `HEAD` (25/25). Treat any failure as a real regression; verify on a clean `HEAD` (e.g. `git stash`) before assuming it is pre-existing.

## Performance expectations

Backend contract endpoints should stay cheap enough for iterative agent prototyping. If a new route adds filesystem, GitHub, Pi/LLM, GPU, or subprocess work, keep the expensive part explicit in the contract and test the pure transformation/validation layer separately.

## Frontend / UX iteration workflow

For CSS/markup work, drive the running app with `agent-browser` (see `.agents/skills/pi-review-ux/SKILL.md`) instead of only reading code. The reliable loop:

- `npm run dev` serves Vite at `http://127.0.0.1:5173` and the API at `:43133`. Open a real PR (the e2e default is `https://github.com/Dao-AILab/flash-attention/pull/2542`) to reach the review surfaces.
- Reproduce inline-thread state by clicking an added diff row. A single dispatched `click` opens the thread; do NOT also dispatch mousedown+mouseup, because the row's drag handlers + click toggle the thread back closed.
- Guard every `agent-browser` call with a `timeout` (e.g. `timeout 15 agent-browser ...`); if the dev server dies, an unguarded call blocks the whole session.

### rolldown-vite stale-transform gotcha (important)

This repo runs rolldown-vite (`vite@8.x`), whose dev HMR sometimes serves a **stale transform**: the saved source has your edit but `http://127.0.0.1:5173/web/src/<file>` returns the old code, so the browser renders pre-edit markup even after a hard reload.

- Confirm with `curl -s http://127.0.0.1:5173/web/src/main.tsx | rg -c 'my-new-token'`.
- If stale, kill the `npm run dev` tree, `rm -rf node_modules/.vite`, then restart `npm run dev`.
- Prefer the loop: batch several edits → restart dev once → verify the served module contains your token → drive the browser. Do not rely on HMR for markup/class changes.

### Shared CSS conventions (keep new UI consistent)

- Modals: render through `ModalShell`, which already provides the single shared `XIcon` close button (`.modal-close-button`) and the `.review-modal-card` flex column. Use `.pi-modal-head` / `.pi-modal-body` / `.pi-modal-foot`; the body is the single `flex:1; min-height:0; overflow:auto` scroll region — do not add `max-height: calc(90vh - Npx)`.
- Auto-growing textareas: use `autoGrowTextarea` from `web/src/lib/dom.ts` (`rows={1}` + `onInput`), not fixed `min-height` boxes.
- Status: only the review-status badge is a colored pill; render other metadata as plain muted text with `·` separators (see `.pr-header-meta` / `.pr-card-meta`).
- Tabs: prefer the flat underline idiom (`.side-tab` active = `box-shadow: inset 0 -2px 0 var(--accent)`), not novelty/pill treatments.
- Collapsible `<details>`: add a `.disclosure-chevron` span so it has a visible affordance (rotates via `details[open] > summary .disclosure-chevron`).
- Use theme variables (`--accent`, `--thread-accent`, `--success`, `--attention`, `--danger`) rather than hardcoded hex; the app has three themes.
