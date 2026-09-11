# Archived feedback

Archiving clears active review drafts but retains the review body, individual comments, reviewed HEAD, and captured change context in local review memory. It does not publish to GitHub or mean the concerns are resolved. Archives remain available after refreshing the PR, restarting the app, or removing/reopening the local PR workspace, subject to the existing 10,000-record review-memory retention limit.

The embedded Pi terminal exposes `read_archived_feedback` for this workflow:

> Check my latest archived feedback against this revision. For each concern, tell me whether it is addressed, still open, or unverified, with evidence.

The tool lists archives for the terminal's PR, then retrieves an archive by ID when requested. Older pages are available through `offset`. Historical comments and line numbers belong to the recorded HEAD, not necessarily the current file paths or lines. Captured diff context can be partial; the agent must inspect current code and available Git history rather than treating archive text as proof of a fix. Testing limitations must remain explicit.

No archived comments are restored into the diff, draft list, or chat automatically. Tool discovery adds instructions, not the archive contents. Reading history never edits archives, marks findings resolved, changes drafts, or contacts GitHub.

## Backend contract

`POST /api/review/archive/history` accepts:

- `{ "prKey": "github.com/owner/repo#123", "offset": 0 }`: up to 20 compact summaries and `nextOffset` (`null` at the end).
- `{ "prKey": "github.com/owner/repo#123", "archiveId": "..." }`: the stored archive, including its body, comments, historical HEAD and captured context.

The storage query filters by PR and archived disposition before pagination. Published reviews and other PRs cannot displace or be retrieved as this PR's archived feedback. This is exact local retrieval, not a semantic-search/RAG service.
