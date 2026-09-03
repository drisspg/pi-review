import { ghstackWorkspaceInstructions } from "./ghstack-guidance.js";

type ReviewPromptMode = "code-walk" | "guide-review" | "main-review" | "focus-review" | "test-pr" | "ai-chat" | "inline-chat" | "focus-chat" | "review-feedback" | "github-draft-handoff";

type PromptFile = {
  additions?: number;
  deletions?: number;
  filename: string;
  patch?: string;
  status?: string;
};

type PromptFeedbackItem = {
  author?: string;
  body: string;
  kind?: string;
  location?: string;
  state?: string;
  updatedAt?: string;
  url?: string;
};

type PromptAiMessage = {
  kind?: string;
  role: string;
  text: string;
  title?: string;
};

type PromptFocusArea = {
  body: string;
  endLine: number;
  path: string;
  startLine: number;
  title: string;
  viewed?: boolean;
};

type PromptDraftHandoffComment = {
  body: string;
  diffHunk: string;
  line: number | null;
  path: string;
  startLine: number | null;
};

export type ReviewPromptApiDeps = {
  currentReviewMemoryPrompt: () => Promise<string>;
};

export type ReviewPromptResponse = {
  prompt: string;
  purpose: string;
};

export type ReviewPromptApi = {
  build: (payload: Record<string, unknown>) => Promise<ReviewPromptResponse>;
};

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Expected ${key}`);
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function optionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalRecords(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Expected ${key}`);
  return value.map((item) => {
    if (typeof item !== "object" || item == null || Array.isArray(item)) throw new Error(`Expected ${key}`);
    return item as Record<string, unknown>;
  });
}

function promptFeedbackItems(payload: Record<string, unknown>, key: string): PromptFeedbackItem[] {
  return optionalRecords(payload, key).map((record) => {
    const body = optionalRecordString(record, "body");
    if (body == null) throw new Error(`Expected ${key}.body`);
    return {
      author: optionalRecordString(record, "author"),
      body,
      kind: optionalRecordString(record, "kind"),
      location: optionalRecordString(record, "location"),
      state: optionalRecordString(record, "state"),
      updatedAt: optionalRecordString(record, "updatedAt"),
      url: optionalRecordString(record, "url"),
    };
  });
}

function promptAiMessages(payload: Record<string, unknown>): PromptAiMessage[] {
  return optionalRecords(payload, "aiComments").map((record) => {
    const role = optionalRecordString(record, "role");
    const text = optionalRecordString(record, "text");
    if (role == null || text == null) throw new Error("Expected aiComments role and text");
    return { role, text, kind: optionalRecordString(record, "kind"), title: optionalRecordString(record, "title") };
  });
}

function promptFocusAreas(payload: Record<string, unknown>): PromptFocusArea[] {
  return optionalRecords(payload, "focusAreas").map((record) => {
    const path = optionalRecordString(record, "path");
    const startLine = record.startLine;
    const endLine = record.endLine;
    if (path == null || typeof startLine !== "number" || typeof endLine !== "number") throw new Error("Expected focusAreas location");
    // A focus scan can list a location with only a title (or nothing after it); that is still a valid area.
    return { body: optionalRecordString(record, "body") ?? "", endLine, path, startLine, title: optionalRecordString(record, "title") ?? "Focus area", viewed: record.viewed === true };
  });
}

function promptFiles(payload: Record<string, unknown>): PromptFile[] {
  const files = payload.files;
  if (!Array.isArray(files)) throw new Error("Expected files");
  return files.map((file) => {
    if (typeof file !== "object" || file == null || Array.isArray(file)) throw new Error("Expected files");
    const record = file as Record<string, unknown>;
    if (typeof record.filename !== "string") throw new Error("Expected files");
    return {
      additions: typeof record.additions === "number" ? record.additions : undefined,
      deletions: typeof record.deletions === "number" ? record.deletions : undefined,
      filename: record.filename,
      patch: typeof record.patch === "string" ? record.patch : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
    };
  });
}

function patchSummary(files: PromptFile[]): string {
  return files.map((file) => `## ${file.filename}\n${file.patch ?? "Patch unavailable"}`).join("\n\n");
}

function statusPatchSummary(files: PromptFile[]): string {
  return files.map((file) => `## ${file.filename}\nStatus: ${file.status ?? "unknown"}, +${file.additions ?? 0}/-${file.deletions ?? 0}\n${file.patch ?? "Patch unavailable"}`).join("\n\n");
}

function rangeText(payload: Record<string, unknown>): string {
  const line = payload.line;
  const startLine = payload.startLine;
  if (typeof line !== "number") return "file";
  return typeof startLine === "number" && startLine !== line ? `${startLine}-${line}` : String(line);
}

function focusRange(payload: Record<string, unknown>): string {
  const startLine = payload.startLine;
  const endLine = payload.endLine;
  if (typeof startLine !== "number" || typeof endLine !== "number") throw new Error("Expected focus range");
  return startLine === endLine ? String(startLine) : `${startLine}-${endLine}`;
}

function codeWalkPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const prTitle = requiredString(payload, "prTitle");
  const diffSummary = statusPatchSummary(promptFiles(payload));
  return {
    purpose: "flow-dag",
    prompt: `Use the show-me skill style to show me what's going on in PR ${prKey}. This is a visual orientation for a reviewer, not a findings report. When your session has the show-me or pr-context skills available, use them to ground the answer in the real change.

Return only the final markdown inline. Do not create files or mention your process, commands, tests, or where anything was saved.

Structure the answer as exactly these sections, in this order, so the review UI can lay them out as panels:
## TL;DR
Two to four sentences: the PR's goal, the key implementation idea, and why this approach.
## Schematic
Ground the reviewer visually with one or more fenced \`\`\`schematic blocks. Each block is one JSON diagram the review UI renders as an interactive canvas:
\`\`\`schematic
{
  "title": "Execution path",
  "direction": "right",
  "groups": [{ "id": "wiring", "label": "CP wiring" }],
  "nodes": [
    { "id": "apply_cp", "label": "apply_cp()", "detail": "selects the MLA path", "ref": "torchtitan/models/kimi_k3/parallelize.py:105", "kind": "entry", "group": "wiring" },
    { "id": "forward", "label": "KimiK3Model.forward", "ref": "torchtitan/models/kimi_k3/model.py:132", "kind": "core" }
  ],
  "edges": [{ "from": "apply_cp", "to": "forward", "label": "wires", "kind": "call" }]
}
\`\`\`
Contract:
- "direction": "right" for call/data flow, "down" for layered or lifecycle structure.
- Node "kind": "entry" (where reading starts), "core" (main logic), "state" (owned state/lifecycle), "boundary" (API/config/process boundary), "test" (validation). "label" is a real identifier from the diff, "detail" one short clause, "ref" a real changed file:line, "group" optional.
- Edge "kind": "call" (control flow), "data" (data/tensor flow), "state" (state transition); "label" is three words or fewer.
Keep each diagram to at most 12 nodes. A small change may need a single diagram; a layered change may deserve one block per distinct aspect (execution path, state lifecycle, ownership boundaries), and each extra diagram must explain something the others cannot. Use a compact text call tree or code-shape sketch instead only when exact source structure communicates the change more clearly than a graph.
## Change map
Group the changed files by their role in the change (core behavior, API surface, supporting plumbing, tests). One tight line per file or coherent group: \`path\` — what changed there and why it matters to a reviewer.
## Reviewer notes
Three to six bullets: where to start, the order to read, contracts or invariants to verify, and anything easy to miss. Cite real file:line references.

Scale every section to the actual PR — short sections for small changes, never padding. Avoid generic praise and review findings unless a tradeoff is necessary to understand the design.

PR title: ${prTitle}

${diffSummary}`,
  };
}

function guideReviewPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const prTitle = requiredString(payload, "prTitle");
  return {
    purpose: "guide-review",
    prompt: `Create a conceptual review walkthrough for PR ${prKey}. This is an orientation guide, not a risk scan and not a findings review. Always explain how the implementation fits together, even when the change appears correct.

Order the walkthrough by how a reviewer should understand the change, not filesystem order:
1. Start with the core behavioral or architectural change and its best entry point.
2. Follow the important consequences through callers, data flow, state, or API boundaries.
3. Separate supporting glue, compatibility work, and secondary refactors from the core path.
4. End with tests or validation that demonstrate the intended behavior.

Return only markdown in this exact parseable shape:
## Review guide
### 1. Short conceptual chapter title
One or two sentences explaining the purpose of this chapter and how it connects to the walkthrough.
- path:startLine-endLine — First review stop
  One or two sentences explaining exactly what the reviewer should understand at this location.
- another/path.py:line — Second review stop
  One or two sentences explaining how this location advances the chapter.
### 2. Next conceptual chapter
One or two sentence chapter overview.
- path:line — Next review stop
  One or two sentence explanation.

Scale the walkthrough to the actual PR. A tiny local change may need one chapter and one stop; a cross-cutting change may need many chapters and stops. Do not pad to a minimum, impose a fixed maximum, or omit a meaningful part of the call path merely to fit a count. Each stop must cite a real changed file and reviewable changed line from the supplied patch.

Every stop must earn its place: a stop exists to explain one idea the reviewer could get wrong, not to enumerate edits. Mechanical or repetitive plumbing — re-exports, import wiring, __all__ or registry entries, renames, and the same promotion repeated across files — is a single stop anchored at the most representative location, with the other locations named inline in that stop's explanation. Never emit one stop per hunk, per file, or per line of an import list; if two adjacent stops would be reviewed with the same thought, merge them. Stops should collectively cover the chapter's important control flow, data flow, or contract while staying few enough that each one carries real explanatory weight.

Do not report bugs, severities, praise, commands, or your investigation process. Mention risks only when they are necessary to understand the design tradeoff.

PR title: ${prTitle}

${statusPatchSummary(promptFiles(payload))}`,
  };
}

async function mainReviewPrompt(payload: Record<string, unknown>, deps: ReviewPromptApiDeps): Promise<ReviewPromptResponse> {
  const prKey = requiredString(payload, "prKey");
  const previousAiReview = optionalString(payload, "previousAiReview", "No previous full review is stored.");
  const previousFocusAreas = optionalString(payload, "previousFocusAreas", "No previous focus scan findings are stored.");
  const reviewMemory = await deps.currentReviewMemoryPrompt();
  return {
    purpose: "main-review",
    prompt: `Run a concise code review for ${prKey}. Focus on correctness, edge cases, tests, and concrete actionable findings. Avoid generic praise. Return markdown with bullets and file/line references where possible.

Reviewer preference memory:
${reviewMemory}

Previous full review:
${previousAiReview}

Previous focus scan state:
${previousFocusAreas}

For reruns, do not repeat substantially identical findings from the previous full review or reviewed focus items unless the current diff materially changes the concern. Prefer genuinely new, unresolved, or still-unreviewed issues. If prior concerns now appear addressed, summarize that briefly instead of re-reporting them as findings.

${patchSummary(promptFiles(payload))}`,
  };
}

async function focusReviewPrompt(payload: Record<string, unknown>, deps: ReviewPromptApiDeps): Promise<ReviewPromptResponse> {
  const prKey = requiredString(payload, "prKey");
  const prTitle = requiredString(payload, "prTitle");
  const previousFocusAreas = optionalString(payload, "previousFocusAreas", "No previous focus scan findings are stored.");
  const reviewMemory = await deps.currentReviewMemoryPrompt();
  return {
    purpose: "focus-review",
    prompt: `You are a second, independent PR-review pass for ${prKey}. Look specifically for high-signal areas worth deeper human review, not a normal exhaustive review. Prioritize:
- concrete inconsistencies with nearby codebase patterns or API contracts
- surprising behavior, hidden assumptions, or edge cases with plausible impact
- tests, migrations, performance, concurrency, or compatibility risks supported by evidence
- subtle tradeoffs that remain genuinely unresolved after inspecting the code and its conventions

Investigate before reporting. For every candidate, inspect the surrounding implementation, nearby precedent, tests, and relevant language or build-system semantics, then actively try to disprove the concern. Suppress it when the behavior is standard, matches adjacent code, preserves an intentional user override, is answered by the diff or repository, or depends only on a speculative future scenario. A technically true observation is not a focus area unless it exposes a realistic failure mode or a consequential unresolved design choice.

Do not flag stale generated state, old build directories, prior cache entries, or other incremental-environment residue merely because a clean configuration picks up the new behavior. Treat clean configuration as the normal contract unless the repository explicitly guarantees in-place migration, CI demonstrably reuses that state, or stale state causes a correctness failure rather than only missing an optimization. In particular, do not recommend forcing a cached build option when that would remove a supported user override without evidence that the project intends to forbid the override.

Do not manufacture questions to fill the list. "Could this be intentional?", "should this be different?", and similar questions are not findings without concrete evidence that the current behavior is wrong or risky. Prefer no findings over a weak finding.

Reviewer preference memory:
${reviewMemory}

Previous focus scan state:
${previousFocusAreas}

If a finding is substantially the same as a previous reviewed finding, do not return it again unless the current diff materially changes the concern. If it is substantially the same as a previous unreviewed finding, keep it and use the closest current location. Prefer surfacing genuinely new or still-unreviewed findings over re-listing already-reviewed ones.

Return markdown with a "Focus areas" list. Start each item with a clickable-style location in this exact format: \`path:startLine-endLine — short title\` or \`path:line — short title\`. Then state the evidence, realistic impact, and the specific unresolved reviewer question. Avoid generic praise and blocking language unless there is strong evidence. If no candidate survives investigation, return exactly: \`No focus areas found.\`

PR title: ${prTitle}

${statusPatchSummary(promptFiles(payload))}`,
  };
}

function testPrPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const testIntent = requiredString(payload, "testIntent");
  const gpuRequired = payload.gpuRequired === true;
  const files = Array.isArray(payload.files) ? promptFiles(payload) : [];
  const changedFiles = files.length === 0 ? "No changed-file summary was provided. Inspect the checked-out PR worktree and current PR metadata before choosing tests." : `Changed files:\n${statusPatchSummary(files)}`;
  return {
    purpose: "test-pr",
    prompt: `Test PR ${prKey} from the command line before relying on frontend/manual inspection.

Test intent:
${testIntent}

Execution contract:
- Work from the checked-out PR worktree and inspect current files before choosing commands.
- Prefer the smallest backend/CLI validation that proves the requested feature or behavior works.
- If this is a new backend feature, exercise the backend contract directly first with unit tests, a focused Node/CLI command, or HTTP request against the local server.
- Only use frontend/browser checks after the backend behavior is proven or when the request specifically needs UI wiring.
- Run real behavioral tests when available; do not substitute typecheck/build/import checks for behavior.
- Report exact commands, relevant outputs, and whether each check proves the requested behavior.
- If a command fails, debug and iterate until the behavior is proven, the failure is explained as unrelated, or a real blocker is identified.
${gpuRequired ? "- GPU validation was requested. Use the GPU workspace backend/tooling when local CPU validation cannot prove the behavior." : "- Do not allocate GPU resources unless the behavior requires GPU validation."}

${changedFiles}`,
  };
}

const reviewDraftToolInstructions = `In Pi Review, the checkout is a read-only review workspace: never modify repository files. Deliver every proposed change — a fix, refactor, or suggested diff — as an editable review draft with the draft_review_comment tool, with the proposed code in the comment body (a \`\`\`suggestion block when it replaces the anchored lines, otherwise a fenced diff). Requests to add, leave, post, write, or put a comment on the PR or current line also mean draft_review_comment. Call the draft_review_comment tool once for each concrete comment. Draft only comments supported by the current diff, use exact changed-file paths and reviewable diff lines, and write concise comment text in the user's voice. Do not create drafts for ordinary questions or publish anything to GitHub.`;

function aiChatPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const question = requiredString(payload, "question");
  const previousDialogue = optionalString(payload, "previousDialogue", "(none)");
  return {
    purpose: "chat",
    prompt: `Continue discussing PR ${prKey}. Answer the user's latest question using the checked-out PR worktree. Be concise and cite files/lines when useful.\n\n${ghstackWorkspaceInstructions(prKey)}\n\n${reviewDraftToolInstructions}\n\nPrevious dialogue:\n${previousDialogue}\n\nUser: ${question}`,
  };
}

function inlineChatPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const path = requiredString(payload, "path");
  const side = requiredString(payload, "side");
  const hunk = requiredString(payload, "hunk");
  const question = requiredString(payload, "question");
  const previousDialogue = optionalString(payload, "previousDialogue", "(none)");
  return {
    purpose: "inline-chat",
    prompt: `Review PR ${prKey}. File: ${path}. Lines: ${rangeText(payload)}. Side: ${side}.

Diff hunk context:
${hunk}

Previous dialogue:
${previousDialogue}

Use the diff hunk as context for the question and keep the answer concise. The hunk includes removed (-), added (+), and unchanged context lines. Do not start with a formulaic preface like "From the hunk". Use inspection tools only if the question cannot be answered from the hunk or asks for broader context.

${ghstackWorkspaceInstructions(prKey)}

${reviewDraftToolInstructions}

Question: ${question}`,
  };
}

function focusChatPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const path = requiredString(payload, "path");
  const body = requiredString(payload, "body");
  const question = requiredString(payload, "question");
  return {
    purpose: "focus-chat",
    prompt: `Review PR ${prKey}. Focus area: ${path}:${focusRange(payload)}\n\nFocus finding:\n${body}\n\n${ghstackWorkspaceInstructions(prKey)}\n\n${reviewDraftToolInstructions}\n\nQuestion: ${question}`,
  };
}

function authorLabel(author: string | undefined): string | undefined {
  if (author == null) return undefined;
  return author.startsWith("@") ? author : `@${author}`;
}

function metadataLine(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part != null && part.length > 0).join(" · ");
}

function formatFeedbackItems(items: PromptFeedbackItem[]): string {
  if (items.length === 0) return "No GitHub/user comments were captured.";
  return items.map((item, index) => `### ${index + 1}. ${metadataLine([item.kind ?? "Comment", authorLabel(item.author), item.location, item.state, item.updatedAt, item.url])}\n${item.body}`).join("\n\n");
}

function formatAiMessages(messages: PromptAiMessage[]): string {
  if (messages.length === 0) return "No AI panel chat comments were captured.";
  return messages.map((message, index) => {
    const role = message.role === "user" ? "User" : message.role === "pi" ? "Pi" : message.role;
    return `### ${index + 1}. ${metadataLine([role, message.title, message.kind])}\n${message.text}`;
  }).join("\n\n");
}

function formatFocusAreas(areas: PromptFocusArea[]): string {
  if (areas.length === 0) return "No parsed focus areas were captured.";
  return areas.map((area, index) => {
    const range = area.startLine === area.endLine ? String(area.startLine) : `${area.startLine}-${area.endLine}`;
    return `### ${index + 1}. ${area.path}:${range} — ${area.title}${area.body.length > 0 ? `\n${area.body}` : ""}`;
  }).join("\n\n");
}

function promptDraftHandoffComments(payload: Record<string, unknown>): PromptDraftHandoffComment[] {
  return optionalRecords(payload, "comments").map((record) => {
    const path = optionalRecordString(record, "path");
    const body = optionalRecordString(record, "body");
    const diffHunk = optionalRecordString(record, "diffHunk") ?? "Patch hunk unavailable.";
    if (path == null || body == null || (record.line !== null && typeof record.line !== "number") || (record.startLine !== null && record.startLine !== undefined && typeof record.startLine !== "number")) throw new Error("Expected GitHub draft comment location and body");
    return { path, body, diffHunk, line: record.line as number | null, startLine: typeof record.startLine === "number" ? record.startLine : null };
  });
}

function githubDraftHandoffPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const prTitle = optionalString(payload, "prTitle", "(untitled)");
  const prUrl = optionalString(payload, "prUrl", "(unknown URL)");
  const headSha = optionalString(payload, "headSha", "(unknown head)");
  const comments = promptDraftHandoffComments(payload);
  if (comments.length === 0) throw new Error("Expected GitHub draft comments");
  const blocks = comments.map((comment, index) => {
    const range = comment.line == null ? "file" : comment.startLine != null && comment.startLine !== comment.line ? `${comment.startLine}-${comment.line}` : String(comment.line);
    return `## Private draft ${index + 1}: ${comment.path}:${range}\n${comment.body}\n\nDiff hunk context:\n\`\`\`diff\n${comment.diffHunk}\n\`\`\``;
  }).join("\n\n");
  return {
    purpose: "github-draft-handoff",
    prompt: `Work through the private GitHub review drafts for ${prKey}. Treat them as reviewer notes for the current PR head, not as already-published GitHub feedback.

Inspect the referenced code before changing it. Address each valid note at the narrowest authoritative layer, add or update focused tests, and report what changed for every draft. If a note is incorrect or ambiguous, explain why instead of forcing a change. Do not publish, submit, edit, or delete the GitHub review drafts.

PR: ${prKey}
URL: ${prUrl}
Title: ${prTitle}
Head: ${headSha}

${blocks}`,
  };
}

function reviewFeedbackPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const prTitle = optionalString(payload, "prTitle", "(untitled)");
  const prUrl = optionalString(payload, "prUrl", "(unknown URL)");
  const headSha = optionalString(payload, "headSha", "(unknown head)");
  const globalFeedback = optionalString(payload, "globalFeedback", "No global AI feedback was captured.");
  const userComments = promptFeedbackItems(payload, "userComments");
  const aiComments = promptAiMessages(payload);
  // Checked-off focus areas mean "handled or deliberately dismissed" — they stay out of the feedback pool.
  const focusAreas = promptFocusAreas(payload).filter((area) => area.viewed !== true);
  const dismissedCount = promptFocusAreas(payload).length - focusAreas.length;

  return {
    purpose: "review-feedback",
    prompt: `You are helping triage PR review feedback. Use the collected feedback below to produce a concise action plan for the engineer.

Treat GitHub/user comments as source-of-truth reviewer feedback. Treat Pi/AI comments, focus areas, and global feedback as suggestions that should be verified against the code before acting. Deduplicate overlapping points, identify unresolved actionable items, and suggest code/test follow-ups when there is enough context.

Never draft, suggest, or return reply text for review threads — replies are written by the engineer, in their own voice. For each thread that needs a human response, flag it as needing a reply and summarize what we think is happening: the reviewer's actual question or concern, the relevant code facts, and whether the concern looks valid, already addressed, or based on a misunderstanding.

# PR review feedback bundle

PR: ${prKey}
URL: ${prUrl}
Title: ${prTitle}
Head: ${headSha}

## GitHub/user comments
${formatFeedbackItems(userComments)}

## AI panel chat comments
${formatAiMessages(aiComments)}

## AI focus areas
${dismissedCount > 0 ? `The reviewer checked off ${dismissedCount} focus area${dismissedCount === 1 ? "" : "s"} as handled or not worth addressing; those are deliberately excluded.\n\n` : ""}${formatFocusAreas(focusAreas)}

## AI global feedback
${globalFeedback}`,
  };
}

export function createReviewPromptApi(deps: ReviewPromptApiDeps): ReviewPromptApi {
  async function build(payload: Record<string, unknown>): Promise<ReviewPromptResponse> {
    const mode = payload.mode;
    if (typeof mode !== "string") throw new Error("Expected mode");
    switch (mode as ReviewPromptMode) {
      case "code-walk":
        return codeWalkPrompt(payload);
      case "guide-review":
        return guideReviewPrompt(payload);
      case "main-review":
        return await mainReviewPrompt(payload, deps);
      case "focus-review":
        return await focusReviewPrompt(payload, deps);
      case "test-pr":
        return testPrPrompt(payload);
      case "ai-chat":
        return aiChatPrompt(payload);
      case "inline-chat":
        return inlineChatPrompt(payload);
      case "focus-chat":
        return focusChatPrompt(payload);
      case "review-feedback":
        return reviewFeedbackPrompt(payload);
      case "github-draft-handoff":
        return githubDraftHandoffPrompt(payload);
      default:
        throw new Error(`Unknown prompt mode ${mode}`);
    }
  }

  return { build };
}
