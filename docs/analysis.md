# Analysis lifecycle

`src/analysis-api.ts` owns review, focus, guide, and overview runs. The browser requests an analysis; it does not construct its prompt or save the result. Native Pi terminals remain separate from SDK analyses.

## API

- `POST /api/analysis/start`: `{ prKey, headSha, kind, force? }`. Kinds: `main-review`, `focus-review`, `guide-review`, `code-walk`. Returns `{ run }`. Concurrent requests for the same PR/HEAD/kind join one run, including forced refreshes. Without `force`, a saved, validated artifact for the current analysis version is reused.
- `POST /api/analysis/status`: `{ runId }`. Returns `{ run }`, with activity while running and a typed result after persistence. Starting either review view runs the coordinated pair. Its completed response includes the requested `result` and the other view as `companion`; both have the same `provenance.reviewPairId`. Outcomes are `complete`, `failed`, `invalid`, or `cancelled`.
- `POST /api/focus-scan/progress`: `{ prKey, id, areaStates }`.
- `POST /api/guide-review/progress`: `{ prKey, id, stepStates }`.

The old `/api/pi/review` and `/api/pi/focus-review` job routes have been replaced. Generic ask/stream endpoints remain for conversational integrations. Legacy artifact save routes remain for existing local integrations; explicit IDs cannot overwrite an artifact's content or revision.

## Invariants

1. A run captures a registered checkout and HEAD. Prompts use server-owned diff data; client-supplied prompts/files are not accepted as analysis context.
2. PR open/refresh/cleanup is serialized per PR; checkout preparation is serialized per shared clone. A different checkout HEAD or an existing checkout on cleanup now refuses before invalidating analyses or disposing sessions. Checkout deletion requires explicit offline cache maintenance, excluded by the server's lifetime cache lock. After successful preparation, a new registered revision invalidates old analysis observers and SDK queues and disposes SDK sessions/terminals before publishing context. Sending a termination signal alone is not proof that a terminal exited.
3. Completed artifacts persist independently of browser navigation. In-memory run status is bounded and is not restart-durable; after restart, reopen the PR to load saved artifacts and start unfinished work again.
4. Results have immutable content, revision, creation time, and provenance (run, analysis version, actual model, effort). Reviewer progress is patched separately by artifact ID and cannot make old results current.
5. A focus scan is clean only after a successful explicit `No focus areas found.` conclusion with no parsed findings. Legacy scans may include preceding investigation notes; new paired scans keep private verification notes out of the published cards. Unparseable output is invalid, never clean. Generated focus/guide locations are HEAD-file navigation references: exact current changed-file paths (not deleted files) and positive safe integer line ranges. Surrounding unchanged code and ranges spanning hunks are allowed; missing patches do not invalidate navigation. The captured diff cannot establish full-file EOF bounds, so prompts require inspecting HEAD text before citing unseen lines, while the UI loads that text on demand. Do not reuse GitHub comment-anchor validation for analysis: actual inline comments still require reviewable endpoints within a single diff hunk. Raw invalid output remains in run diagnostics.
6. Streaming commentary is separate from the settled final assistant answer. Successful SDK retries do not inherit an earlier attempt's failure.
7. New findings start unreviewed. A nearby old location is not evidence that the reviewer already handled a new concern.

`REVIEW_PAIR_VERSION` in `src/analysis-types.ts` controls General/Focus freshness; `ANALYSIS_VERSION` covers guide and overview. Increment the applicable version when previously successful artifacts need regeneration. Legacy saved artifacts without provenance are regenerated on the next automatic analysis.

## Validation

Offline tests cover run deduplication, navigation-independent persistence, invalid outputs and anchors, cancellation, retry recovery, immutable history/progress, stale draft writes, and terminal teardown. Browser tests cover clean/error states, guide progress across reload, refreshed HEADs, and cleanup/reopen.

## General and Focus

General and Focus first examine the same revision independently. General assesses the intended change and its design. Focus traces one or two high-consequence failure paths. In a second turn Focus tests the provisional blockers against its evidence; General then synthesizes the landing judgment. Guide and overview stay independent. The browser can start or refresh the pair from either view; overlapping requests join, even across views or browsers.

General explains the main change and its effect in plain language. Each Focus finding names an observable outcome, walks through a small supported example, labels runtime versus source evidence, and gives a check that could disprove it. A `### path:line — outcome` heading starts each new finding. Long traces go under an optional `### Evidence` disclosure; source citations within them are not additional findings. Each new finding includes a visual beside the explanation it supports, in both the diff and the panel. Choose the smallest useful representation: a fenced `text` row layout, work partition, or worked calculation, a `diff` sketch, or a graphical relationship. It need not come last. General illustrates the main change even on a clean scan. Use a fenced `schematic` JSON graph for structural relationships: for example, arrows between workers and row intervals show which worker owns each interval. The validator uses the same parser as the canvas and requires valid references and an edge between distinct nodes. If edge labels overlap or become too small at the fitted zoom, a readable key beneath the canvas lists each connection by its source and destination. Use a fenced `review-visual` block only for a simple same-input comparison (two labeled paths, 2–4 short steps per lane, separated by →).

A missing or malformed diagram gets one formatting retry in the same session. The retry returns only the diagram; the server inserts it without rewriting the verdict, findings, or evidence. An ambiguous replacement or a still-invalid artifact rejects the pair, retaining the original response for diagnostics. Saved history is not rewritten.

The panel, inline card and copied feedback use the same saved finding; expanding or collapsing evidence does not change the copy.

Only the verdict and verified inline findings are saved as review artifacts, in one state write; native Pi session logs retain the underlying turns. The verifier's notes above the `## Focus areas` boundary inform synthesis but do not become cards or copied actions. An explicit `Investigation inconclusive: …` reports a missing decisive check, not a clean scan. If a stage fails, neither new artifact is published. Legacy unpaired artifacts remain available in history but cannot satisfy a new paired run. Compare new and old results on the same revisions; distinguish reproduced bugs and false blockers from simply producing more comments.
