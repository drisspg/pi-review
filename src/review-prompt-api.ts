type ReviewPromptMode = "code-walk" | "main-review" | "focus-review" | "test-pr" | "ai-chat" | "inline-chat" | "focus-chat" | "review-feedback";

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
    const body = optionalRecordString(record, "body");
    const startLine = record.startLine;
    const endLine = record.endLine;
    if (path == null || body == null || typeof startLine !== "number" || typeof endLine !== "number") throw new Error("Expected focusAreas location and body");
    return { body, endLine, path, startLine, title: optionalRecordString(record, "title") ?? "Focus area", viewed: record.viewed === true };
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

function optionalPromptFiles(payload: Record<string, unknown>): PromptFile[] {
  return Array.isArray(payload.files) ? promptFiles(payload) : [];
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
    prompt: `Create a reviewer-friendly code walk for PR ${prKey}. This is a separate orientation document, not a findings review. Help a reviewer understand the PR before reading the diff.

Return only the final markdown document inline. Do not create files. Do not mention your process, commands, tests, or where you saved anything.

Include these sections in markdown:
1. **PR goal** — infer the user-visible or maintainer-facing goal from the title and diff.
2. **Walk map** — include exactly one fenced \`\`\`mermaid block. Use \`flowchart LR\` by default, or \`flowchart TD\` when the change is naturally staged top-to-bottom. Make it an orientation map, not a forced file-by-file path. Pick one visual story that best explains the PR: request/data flow, state transitions, API boundary, before/after split, or subsystem fan-in/fan-out.
   - Use the smallest number of nodes that makes the change clear; small PRs may need 4-10 nodes, but large feature PRs should use more nodes when that materially improves orientation.
   - Use subgraphs for ownership/boundaries such as UI, server, storage, kernel, tests, or external systems.
   - Label edges with verbs or data names when useful, but keep labels under 4 words.
   - Keep Mermaid syntax conservative: alphanumeric node ids, quoted labels, no markdown inside labels, no raw parentheses in labels, and no lowercase \`end\` node text.
   - If the PR is mostly local refactoring with no meaningful flow, draw a dependency/ownership map instead.
3. **Reviewer route** — add 3-6 bullets that tell the reviewer the best order to read the diff. Each bullet should name the diagram node or edge, cite files/lines, and say what question to answer there.
4. **Key code patterns** — include a small markdown table with at most 5 rows and columns: Pattern, Where, Why it matters. Do not paste code in this table; keep each cell to one short phrase or sentence.
5. **Code walk** — use subheadings that correspond to the major regions or nodes in the Mermaid diagram. Walk through the PR in the order that best explains the change, which may be grouped by subsystem rather than linear file order. Cite real file/line references and include only short fenced code snippets for the most important changed snippets.
6. **What changed in behavior** — summarize how data, state, or API behavior differs after this PR.

Keep it concrete and readable. Prefer actual identifiers from the diff over vague descriptions. Keep snippets short: only the few lines needed to explain the pattern. Avoid review findings unless they are needed to explain flow. If the diagram would be misleading, say why in one sentence before the Mermaid block and still provide the best small map you can.

PR title: ${prTitle}

${diffSummary}`,
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
    prompt: `You are a second, independent PR-review pass for ${prKey}. Look specifically for areas worth deeper human review, not a normal exhaustive review. Prioritize:
- code that feels inconsistent with nearby codebase patterns or API conventions
- surprising behavior, hidden assumptions, edge cases, or subtle tradeoffs
- tests, migrations, performance, concurrency, or compatibility risks that deserve investigation
- places where the implementation may be valid but reviewers should explicitly decide if the tradeoff is acceptable

Reviewer preference memory:
${reviewMemory}

Previous focus scan state:
${previousFocusAreas}

If a finding is substantially the same as a previous reviewed finding, do not return it again unless the current diff materially changes the concern. If it is substantially the same as a previous unreviewed finding, keep it and use the closest current location. Prefer surfacing genuinely new or still-unreviewed findings over re-listing already-reviewed ones.

Return markdown with a "Focus areas" list. Start each item with a clickable-style location in this exact format: \`path:startLine-endLine — short title\` or \`path:line — short title\`. Then include why it is weird or worth investigation and a concrete reviewer question. Avoid generic praise and avoid blocking language unless there is strong evidence.

PR title: ${prTitle}

${statusPatchSummary(promptFiles(payload))}`,
  };
}

function testPrPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const testIntent = requiredString(payload, "testIntent");
  const gpuRequired = payload.gpuRequired === true;
  const files = optionalPromptFiles(payload);
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

function aiChatPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const question = requiredString(payload, "question");
  const previousDialogue = optionalString(payload, "previousDialogue", "(none)");
  return {
    purpose: "chat",
    prompt: `Continue discussing PR ${prKey}. Answer the user's latest question using the checked-out PR worktree. Be concise and cite files/lines when useful.\n\nPrevious dialogue:\n${previousDialogue}\n\nUser: ${question}`,
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

Use the diff hunk as context for the question and keep the answer concise. The hunk includes removed (-), added (+), and unchanged context lines. Do not start with a formulaic preface like "From the hunk". Use tools only if the question cannot be answered from the hunk or asks for broader context.

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
    prompt: `Review PR ${prKey}. Focus area: ${path}:${focusRange(payload)}\n\nFocus finding:\n${body}\n\nQuestion: ${question}`,
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
    return `### ${index + 1}. ${area.path}:${range} — ${area.title} · ${area.viewed === true ? "reviewed" : "unreviewed"}\n${area.body}`;
  }).join("\n\n");
}

function reviewFeedbackPrompt(payload: Record<string, unknown>): ReviewPromptResponse {
  const prKey = requiredString(payload, "prKey");
  const prTitle = optionalString(payload, "prTitle", "(untitled)");
  const prUrl = optionalString(payload, "prUrl", "(unknown URL)");
  const headSha = optionalString(payload, "headSha", "(unknown head)");
  const globalFeedback = optionalString(payload, "globalFeedback", "No global AI feedback was captured.");
  const focusScan = optionalString(payload, "focusScan", "No focus scan transcript was captured.");
  const userComments = promptFeedbackItems(payload, "userComments");
  const aiComments = promptAiMessages(payload);
  const focusAreas = promptFocusAreas(payload);

  return {
    purpose: "review-feedback",
    prompt: `You are helping triage PR review feedback. Use the collected feedback below to produce a concise action plan for the engineer.

Treat GitHub/user comments as source-of-truth reviewer feedback. Treat Pi/AI comments, focus areas, and global feedback as suggestions that should be verified against the code before acting. Deduplicate overlapping points, identify unresolved actionable items, and suggest reply text or code/test follow-ups when there is enough context.

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
${formatFocusAreas(focusAreas)}

## AI global feedback
${globalFeedback}

## Focus scan transcript
${focusScan}`,
  };
}

export function createReviewPromptApi(deps: ReviewPromptApiDeps): ReviewPromptApi {
  async function build(payload: Record<string, unknown>): Promise<ReviewPromptResponse> {
    const mode = payload.mode;
    if (typeof mode !== "string") throw new Error("Expected mode");
    switch (mode as ReviewPromptMode) {
      case "code-walk":
        return codeWalkPrompt(payload);
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
      default:
        throw new Error(`Unknown prompt mode ${mode}`);
    }
  }

  return { build };
}
