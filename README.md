# pi-review

A local PR-review cockpit: paste a GitHub PR, review the diff, draft comments with help from
Pi, and submit the review back to GitHub.
Everything runs on your machine through your own `gh` login and Pi launcher.

## What's in it

**Reviewing a PR**
- GitHub-style unified/split diff with viewed files, inline threads, multiline drafts, CI status,
  blame, and "changes since my last review".
- Pi at every level: ask about a line, run a general or focus review, follow a guided walkthrough,
  or open a native Pi terminal on the checked-out PR. Pi drafts private comments (including
  GitHub "Apply suggestion" blocks), can edit/delete its drafts, and never publishes on its own.
- Stacked PRs (sp/stack-pr and ghstack) show as a strip in the header: position, what landed,
  what you reviewed, one click to the PR below/above.

**Home page**
- Inbox: GitHub notifications ranked into tiers, plus a board of your own PRs.
- PyTorch queues: pre-review, review, and issue triage per the
  [maintainer guide](https://github.com/pytorch/pytorch/blob/main/docs/source/community/maintainer_guide.md).
  A background agent suggests accept/draft/close for each owed pre-review; you can chat with it
  inline. Nothing is posted until you click.
- Review activity: focused time, reviews (synced from GitHub), and pre-review decisions, with a
  weekly trend and a year-to-date Markdown report.
- Local checkouts, with **Prune landed…** to delete checkouts whose PRs merged or landed.

## Requirements

- Node.js and npm
- `git` and an authenticated `gh` (`gh auth status`)
- Pi CLI with a default model configured

## Quick start

```sh
git clone https://github.com/drisspg/pi-review && cd pi-review && npm start
```

Open http://127.0.0.1:43133. `npm start` installs dependencies and rebuilds when needed.
After pulling or rebuilding, restart it (Ctrl-C, then `npm start`); the page tells you when the
running server is older than the UI.

## Configuration

Machine-local settings live in the gitignored `.pi-review.local.json` in this checkout:

```json
{
  "piCommand": "~/dotfiles/scripts/pi-work",
  "model": ["plugboard-codex/gpt-6-astra", "openai/gpt-6-astra"],
  "thinkingLevel": "high",
  "activityLedgerPath": "~/notes/review_activity.jsonl"
}
```

| Key | Effect |
| --- | --- |
| `piCommand` | Pi launcher for terminals and background agents (else `PI_BIN`, else `pi` on PATH) |
| `model` | Model for Pi Review only: `provider/id`, or a preference list. The first is requested; any listed model is accepted (launchers may route one provider to another); anything else is refused |
| `thinkingLevel` | Thinking level for every Pi Review agent and terminal |
| `activityLedgerPath` | Where review-activity data and the year report are written (e.g. a notes vault) |

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `PI_REVIEW_STATE_PATH` | Use a separate state file (and cache/ledger next to it), e.g. for a dev instance |
| `PI_REVIEW_CACHE_DIR` | Checkout cache location |
| `PI_REVIEW_DISABLE_AUTO_REVIEWS=1` | No automatic Pi runs (required for tests and probes) |
| `PI_REVIEW_PRE_REVIEW_ASSESSOR=0` | Turn off the background pre-review agent |
| `PI_REVIEW_ACTIVITY_SYNC=0` / `=1` | Disable / force the daily GitHub review sync |

## Where data lives

- **State** (saved PRs, drafts, reviews, Pi sessions): `~/.pi/agent/state/pi-pr-review/`.
  Submitted reviews also feed a reviewer profile mirrored to `~/agent_notes/findings/`.
- **Checkouts**: `~/Library/Caches/pi-review/` on macOS (`~/.cache/pi-review/` on Linux).
  Deleting or pruning a checkout keeps its saved review; reopening the PR recreates it.
  Deletion refuses anything that might hold unique work. For offline maintenance:
  `npm run cache -- inventory`, then `npm run cache -- evict --offline <id>` with the server stopped.
- **Refresh** resets a PR's checkout to the latest remote commit (local edits are discarded);
  opening a PR whose clean local checkout is on an older PR revision updates it automatically
  (local edits, local commits, or a live Pi terminal still require an explicit reset).

## Development

```sh
npm run dev            # Vite on :5173 + API server, with file watching
npm run typecheck
npm run test:unit
npm run test:e2e:fast  # Playwright against a real PR; needs network and gh
npm run validate       # all of the above
```

Use separate ports and state when another instance is running, e.g.
`PI_PR_REVIEW_PORT=43135 PI_REVIEW_WEB_PORT=5175 PI_REVIEW_STATE_PATH=/tmp/pi-review-dev.json npm run dev`.
Architecture, contracts, and safety rules for contributors and agents are in [AGENTS.md](AGENTS.md).
