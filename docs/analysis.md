# Analysis lifecycle

`src/analysis-api.ts` owns review, focus, guide, and overview runs. The browser requests an analysis; it does not construct its prompt or save the result. Native Pi terminals remain separate from SDK analyses.

## API

- `POST /api/analysis/start`: `{ prKey, headSha, kind, force? }`. Kinds: `main-review`, `focus-review`, `guide-review`, `code-walk`. Returns `{ run }`. Concurrent requests for the same PR/HEAD/kind join one run, including forced refreshes. Without `force`, a saved, validated artifact for the current analysis version is reused.
- `POST /api/analysis/status`: `{ runId }`. Returns `{ run }`, with activity while running and a typed result after persistence. Outcomes are `complete`, `failed`, `invalid`, or `cancelled`.
- `POST /api/focus-scan/progress`: `{ prKey, id, areaStates }`.
- `POST /api/guide-review/progress`: `{ prKey, id, stepStates }`.

The old `/api/pi/review` and `/api/pi/focus-review` job routes have been replaced. Generic ask/stream endpoints remain for conversational integrations. Legacy artifact save routes remain for existing local integrations; explicit IDs cannot overwrite an artifact's content or revision.

## Invariants

1. A run captures a registered checkout and HEAD. Prompts use server-owned diff data; client-supplied prompts/files are not accepted as analysis context.
2. PR open/refresh/cleanup is serialized per PR. A revision transition invalidates analysis observers and SDK queues, disposes SDK sessions and terminals, then replaces the worktree. Sending a termination signal alone is not proof that a terminal exited.
3. Completed artifacts persist independently of browser navigation. In-memory run status is bounded and is not restart-durable; after restart, reopen the PR to load saved artifacts and start unfinished work again.
4. Results have immutable content, revision, creation time, and provenance (run, analysis version, actual model, effort). Reviewer progress is patched separately by artifact ID and cannot make old results current.
5. A focus scan is clean only after a successful explicit `No focus areas found.` conclusion with no parsed findings. Preceding investigation notes are preserved in the UI. Unparseable output is invalid, never clean. Generated focus/guide range endpoints must be reviewable in the captured diff, but may span different hunks; only publishable inline comments require a single hunk. Raw invalid output remains in run diagnostics.
6. Streaming commentary is separate from the settled final assistant answer. Successful SDK retries do not inherit an earlier attempt's failure.
7. New findings start unreviewed. A nearby old location is not evidence that the reviewer already handled a new concern.

`ANALYSIS_VERSION` in `src/analysis-types.ts` is the freshness version for prompt and validation changes. Increment it when prompt or validation changes require regenerating previously successful artifacts. Legacy saved artifacts without provenance are regenerated on the next automatic analysis.

## Validation

Offline tests cover run deduplication, navigation-independent persistence, invalid outputs and anchors, cancellation, retry recovery, immutable history/progress, stale draft writes, and terminal teardown. Browser tests cover clean/error states, guide progress across reload, refreshed HEADs, and cleanup/reopen.

Four analysis modes remain available. Combining them into two default jobs is a separate quality experiment: compare missed defects, false positives, duplicate findings, and valid anchors on a fixed PR set before removing the independent pass. No direct Responses client or unsupported async-tool/steering API has been added.
