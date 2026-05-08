# github-pr-review

Browser GitHub PR review flow for pi.

## Command

```text
/pr-review
/pr-review https://github.com/OWNER/REPO/pull/123
/pr-review OWNER/REPO#123
/pr-review --api-only https://github.com/OWNER/REPO/pull/123
/pr-review --port=43125
/pr-review --port=43125 https://github.com/OWNER/REPO/pull/123
```

With no URL, `/pr-review` opens a browser landing page where you paste the PR URL. The landing page also has a **Clean cached worktrees** button that removes cached PR worktree directories and runs `git worktree prune` on cached base repos.

Default port: `43133` or `PI_GITHUB_PR_REVIEW_PORT`. If the default is busy, `/pr-review` automatically tries nearby ports unless you explicitly pass `--port=`.

## Flow

- Fetches PR metadata, changed files, and existing PR review comments through `gh api`.
- Caches/checks out the **base repository** under `~/.pi/agent/state/github-pr-review/`.
  - For fork PRs into `pytorch/pytorch`, the cached repo is `pytorch/pytorch`, not the fork.
  - The PR head is fetched via the base repo's `refs/pull/<n>/head` ref.
- Starts a localhost browser review app.
- Existing review comments are shown in the sidebar and inline when their line still maps to the rendered diff.
- Click a diff line to open an inline editor.
  - `Ask Pi` sends that inline text as a line-specific question back to pi chat.
  - `Add draft comment` records the inline text as a pending GitHub review comment.
- It does **not** auto-start an AI review in the main pi session; that blocked normal interaction. AI work is only queued when you click `Ask Pi`.
- Submit posts a GitHub pull request review via `gh api` with event:
  - `COMMENT`
  - `APPROVE`
  - `REQUEST_CHANGES`

## Notes

The browser diff and GitHub submission use GitHub as the source of truth for line numbers. The local checkout is for repo search, context gathering, and better AI answers/review feedback.
