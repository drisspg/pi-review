# Pi Review Agent Guidance

Pi Review is a local PR-review cockpit: a React web app (left: GitHub-style diff, right: review/Pi
panel) served by a local Node server that talks to GitHub via `gh` + `git`, manages per-PR
worktrees, and runs Pi agent sessions/terminals. Paste a PR URL, review the diff, draft comments,
ask Pi at line/file/PR scope, and submit the review back to GitHub.

## Repo map

```
src/                    Node server (TypeScript, ESM, run via tsx)
  server.ts             Dependency wiring + lifecycle ONLY — no logic
  server-router.ts      Route dispatch (createServerRoute / createRequestListener)
  *-api.ts              One injectable module per feature contract (pr, comment, draft-review,
                        review-prompt, review-submit, review-memory, saved-analysis, file,
                        gpu-workspace, pi, pi-terminal, ask-stream, review-archive, shell,
                        usage, …)
  state.ts              StateStore: JSON persistence of AppState (PRs, drafts, viewed files,
                        AI/guide/focus-scan records, reviewer memory) at PI_REVIEW_STATE_PATH
  github.ts             gh api / GraphQL calls (PR data, pending reviews, comments)
  worktrees.ts          Per-PR git worktree reuse
  pi-session.ts         Pi agent sessions (ask, prewarm, activity, diagnostics, model select)
  pi-terminal*.ts       Native Pi terminals (node-pty + WebSocket), persisted across reloads
  types.ts              Shared backend types
web/src/                React frontend (Vite)
  main.tsx              Almost all screens/components: App, AppToolbar, StartPage/PrCard,
                        ReviewPage, PrHeaderStrip, PrSummary, GuideReview (Review route rail +
                        OverviewBody four-panel dashboard: TL;DR/Schematic/Change map/Reviewer
                        notes + Pi terminal; reviewed stops persist via guide stepStates),
                        FileNavigator, FileDiff/DiffRowView, ThreadBox, FocusAreaInline,
                        GitHubDraftReviewPanel, ReviewSummary, AiReviewPanel, and the modals
                        (Pi settings, memory, GPU workspace, sessions, logs)
  styles.css            Single stylesheet, ~5k lines. Order: design tokens + 3 theme blocks →
                        base/reset/focus → toolbar/panels → review layout → PR header/mode tabs →
                        guide → file navigator → diff table → threads/composers →
                        markdown → review summary/drafts → start page → Pi panel → modals →
                        media queries → mermaid/schematic/file snippets
  components/           Small shared pieces (Button→.ui-button, Modal→ModalShell, ActionMenu,
                        Tabs, Threads, Markdown*, Mermaid, SchematicDiagram, PiTerminal)
  lib/                  diff parsing, comment helpers, guide steps, overview panel sections
                        (overview.ts parses the code-walk prompt's four-section contract, with a
                        free-form fallback), schematic.ts (typed JSON contract behind fenced
                        ```schematic blocks, rendered by SchematicDiagram via React Flow + ELK;
                        mermaid remains the legacy fallback), focus areas, highlight, dom
tests/unit/             node:test suites for backend api modules (run via tsx)
tests/e2e/              Playwright suite (pr-review.spec.ts, ~55 tests)
scripts/                start.mjs + smoke scripts (gpu-workspace, chat latency)
docs/screenshots/       README images
vscode-extension/       Generated artifacts only (dist/), no source here
.agents/skills/         Project skills (pi-review-ux: browser-driven UX iteration)
```

## Running and iterating

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite at `:5173` + API server at `:43133` (watch mode) |
| `npm run typecheck` | Server + web tsc |
| `npm run test:unit` | All unit tests (fast, no network) |
| `npm run build` | tsc + vite build into `dist-web`/`dist-server` |
| `npm run test:e2e:fast` | Build once, 3 workers, mocked-Pi e2e on port 43134 |
| `npm run test:e2e` | Full e2e (slower, traces/videos on failure) |
| `npm run validate` | typecheck + build + unit + e2e |
| `npm run usage:report` | Summarize the local usage JSONL (feature counts, latency, errors) |

Env vars: `PI_PR_REVIEW_PORT` (API), `PI_REVIEW_WEB_PORT` (Vite), `PI_REVIEW_STATE_PATH` (state
JSON), `PI_REVIEW_USAGE_LOG_PATH` (usage JSONL; defaults to `<state>.usage.jsonl` next to the
state file so test/dev instances never pollute the real log), `PI_REVIEW_TEST_PORT` (Playwright
port override), `PI_REVIEW_FAST_TESTS=1` (fast e2e mode),
`PI_REVIEW_DISABLE_AUTO_REVIEWS=1` (suppress the on-open guide/review/focus warmup — REQUIRED for
any test or probe server, or PR opens will start real Pi jobs);
`PI_REVIEW_API_URL` / `PI_REVIEW_PR_KEY` / `PI_REVIEW_HEAD_SHA` / `PI_REVIEW_TARGET` are injected
into spawned Pi terminal sessions and smoke scripts, not something you set by hand.

Assume a running default-port server belongs to the user or another agent. Do not stop or restart
a dev server you did not launch. For separate feature work, use an isolated worktree plus unique
ports and state, for example:
`PI_PR_REVIEW_PORT=43135 PI_REVIEW_WEB_PORT=5175 PI_REVIEW_STATE_PATH=/tmp/pi-review-$USER-43135.json npm run dev`.
Stop only that process tree; never broad `pkill`/`killall`.

## Backend-first feature workflow

When implementing or prototyping a new Pi Review feature, prove the behavior through the backend
contract before relying on the frontend.

- Put durable feature behavior in an injectable `src/*-api.ts` module with focused unit tests.
- Keep `src/server.ts` as dependency wiring and lifecycle only; route dispatch belongs in
  `src/server-router.ts` or a feature API module.
- Add or extend typed backend contracts before wiring UI text/protocols into React. Use
  `/api/pi/prompt` modes for durable agent prompts instead of constructing long prompts in the
  frontend.
- For "test this PR" or "have an agent try this out" flows, use the `test-pr` prompt contract via
  `/api/pi/prompt` with `{ mode: "test-pr", prKey, testIntent, files?, gpuRequired? }`.
- Validate backend behavior from the CLI first: targeted unit tests, direct module calls, local
  HTTP requests, or command-line repros against the checked-out PR/worktree.
- Only move to frontend/browser checks after the backend behavior is proven, or when the change is
  specifically UI wiring/interaction.

Backend contract endpoints should stay cheap enough for iterative agent prototyping. If a new
route adds filesystem, GitHub, Pi/LLM, GPU, or subprocess work, keep the expensive part explicit
in the contract and test the pure transformation/validation layer separately.

## Frontend / UX iteration workflow

For CSS/markup work, drive the running app with `agent-browser` (see
`.agents/skills/pi-review-ux/SKILL.md`) instead of only reading code. The reliable loop:

- `npm run dev`, then open a real PR — the e2e default is
  `https://github.com/Dao-AILab/flash-attention/pull/2542` — to reach the review surfaces.
- Reproduce inline-thread state by clicking an added diff row. A single dispatched `click` opens
  the thread; do NOT also dispatch mousedown+mouseup, because the row's drag handlers + click
  toggle the thread back closed.
- Guard every `agent-browser` call with a `timeout` (e.g. `timeout 15 agent-browser ...`); if the
  dev server dies, an unguarded call blocks the whole session.

### rolldown-vite stale-transform gotcha (important)

This repo runs rolldown-vite (`vite@8.x`), whose dev HMR sometimes serves a **stale transform**:
the saved source has your edit but `http://127.0.0.1:5173/web/src/<file>` returns the old code, so
the browser renders pre-edit markup even after a hard reload.

- Confirm with `curl -s http://127.0.0.1:5173/web/src/main.tsx | rg -c 'my-new-token'`.
- If stale, restart only the `npm run dev` tree you launched, clear that worktree's
  `node_modules/.vite`, and restart with the same isolated ports.
- Prefer the loop: batch several edits → restart dev once → verify the served module contains your
  token → drive the browser. Do not rely on HMR for markup/class changes.

## Design system (styles.css)

The app has three themes — dark (default), `github-light`, `github-dimmed` — selected via
`:root[data-theme=…]`. Every theme-able value must route through a CSS custom property; theme
blocks override only what differs. A Primer `[data-component="ThemeProvider"]` block re-maps the
core vars for Primer-rendered subtrees.

Token layer (defined once in `:root`; use these, never re-hardcode):

- Spacing: `--space-1..6` (4/8/12/16/20/24px). No ad-hoc 5/7/9/10/14px values.
- Type: `--text-xs/sm/md/lg/xl` (11/12/13/14/16px); `tabular-nums` for line numbers/counters;
  mono (`--font-mono`) only for code/diff/paths, `--font-system` for chrome.
- Radius: `--radius-sm/md/lg/xl` (4/6/8/12px) — controls md, cards lg, modals/popovers xl.
- Controls: `--control-h` (32px) and `--control-h-sm` (28px) button/input heights.
- Motion: `transition: background-color/border-color/color/box-shadow var(--dur-fast) var(--ease)`
  (120ms) on interactive elements. Never `transition: all`; never transitions on `.diff-row*`.
- Color/borders: hierarchy from background shifts (`--bg` → `--panel` → `--panel2`), not nested
  borders; `--border-soft` for internal dividers; `--hover-bg` / `--selected-bg` for states;
  `--on-accent` for text on filled buttons; `--add`/`--del` for diff tints (additions are
  deliberately slightly stronger than deletions — keep that asymmetry).
- Depth: `--shadow-raised` / `--shadow-popover` / `--shadow-modal` + `--overlay-bg`; shadows only
  on floating layers, all theme-aware.
- Sticky offsets derive from `--sticky-toolbar-h` via `calc()` (`.review-page` defines the derived
  `--sticky-mode-tabs-h` / `--sticky-files-toolbar-h` chain). Never reintroduce literal 48/83/127.

Component conventions:

- Modals: render through `ModalShell` (shared `.modal-close-button`, `.review-modal-card` flex
  column). Use `.pi-modal-head` / `.pi-modal-body` / `.pi-modal-foot`; the body is the single
  `flex:1; min-height:0; overflow:auto` scroll region — do not add `max-height: calc(90vh - Npx)`.
- Buttons: one system — `.ui-button` variants plus `.pi-primary`/`.composer-submit` for the rare
  accent-filled primary. The green `.review-changes-button` is the
  single deliberate GitHub-convention primary; don't add more saturated buttons.
- Tabs: flat underline idiom (`.side-tab` active = `box-shadow: inset 0 -2px 0 var(--accent)`),
  not pill treatments.
- Status: only the review-status badge is a colored pill; other metadata is plain muted text with
  `·` separators (see `.pr-header-meta` / `.pr-card-meta`).
- Uppercase micro-labels use the shared `.kicker` utility; keyboard hints use the shared `kbd`
  style; collapsible `<details>` get a `.disclosure-chevron` span.
- Auto-growing textareas: `autoGrowTextarea` from `web/src/lib/dom.ts` (`rows={1}` + `onInput`).
- Text inputs rely on the global soft `:focus-visible` ring (border tint + 3px accent glow); other
  interactive elements get the global 2px accent outline. Don't override either per-component.

## Validation expectations

- Run the most relevant targeted unit tests for the changed backend contract.
- Run `npm run typecheck` and `npm run build` before handoff.
- Run `npm run test:e2e:fast` (or targeted Playwright tests) when frontend/server wiring changes
  materially. E2e opens the pinned flash-attention PR through the real server + `gh`, and mocks Pi
  endpoints/terminal WebSocket in-page — so it needs network + `gh` auth but no Pi backend.
- E2e class names and geometry are load-bearing (e.g. `.review-mode-tabs` sticks at exactly the
  toolbar height; `.focus-area-link-row`, `.draft-card`, `.composer-submit`, terminal textbox
  roles). When restyling, add classes rather than renaming, and keep rendered sticky offsets
  identical unless you update the spec.
- Treat e2e failures as real regressions; verify against a clean `HEAD` worktree
  (`git worktree add /tmp/pi-review-head HEAD` + symlinked `node_modules`) before assuming a
  failure is pre-existing. Known machine caveat: on hosts where agent shells cannot spawn Chromium
  (`bootstrap_check_in … Permission denied`), run with a wrapper config that adds
  `launchOptions: { args: ["--single-process", "--no-sandbox"] }` and one test per invocation;
  under that harness, "minimizes focus area links" and "copies local draft comments" fail on
  `HEAD` too — everything else must pass. Never store wrapper configs or state you care about in
  `test-results/` (Playwright wipes it at startup).

## Skills

- `.agents/skills/pi-review-ux/SKILL.md` — browser-driven UX iteration for this repo
  (agent-browser workflow, isolated instances, validation loop). Load it before UI work.
