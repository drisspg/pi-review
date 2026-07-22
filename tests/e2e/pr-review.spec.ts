import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const prUrl = process.env.PI_REVIEW_TEST_PR ?? "https://github.com/Dao-AILab/flash-attention/pull/2542";
let openedPr: { key: string; headSha: string } | null = null;

async function openFirstFile(page: Page) {
  const firstFile = page.locator(".file").first();
  if (await firstFile.locator(".diff-row").count() === 0) await firstFile.locator(".file-summary-left").click();
  await expect(firstFile.locator(".diff-row").first()).toBeVisible();
}

async function openFileWithAddedRows(page: Page, minRows: number) {
  const files = page.locator(".file");
  for (let index = 0; index < await files.count(); index += 1) {
    const file = files.nth(index);
    if (await file.locator(".diff-row").count() === 0) await file.locator(".file-summary-left").click();
    const rows = file.locator(".diff-row.added");
    if (await rows.count() >= minRows) return rows;
  }
  throw new Error(`No file has ${minRows} added rows`);
}

async function openTools(page: Page) {
  await page.getByRole("button", { name: /Tools/ }).click();
}

async function openSideTab(page: Page, tab: "Review" | "Pi" | "Comments") {
  if (await page.locator(".side").count() === 0) {
    const trigger = tab === "Review" ? /Review changes/ : tab === "Pi" ? /Pi review/ : /Comments/;
    await page.locator(".files-toolbar").getByRole("button", { name: trigger }).click();
  }
  const tabButton = page.getByRole("tab", { name: new RegExp(`^${tab}`) });
  if (await tabButton.getAttribute("aria-selected") !== "true") await tabButton.click();
}

async function openReviewForm(page: Page) {
  await openSideTab(page, "Review");
  const startReview = page.getByRole("button", { name: "Start review" });
  if (await startReview.count() > 0) await startReview.click();
}

async function mockAskPi(page: Page, answerForPrompt: (body: { prompt?: string }) => string) {
  await page.route(/\/api\/ask\/stream$/, async (route) => {
    const answer = answerForPrompt(route.request().postDataJSON() as { prompt?: string });
    await route.fulfill({ contentType: "text/event-stream", body: `event: delta\ndata: ${JSON.stringify({ delta: answer })}\n\nevent: done\ndata: ${JSON.stringify({ answer })}\n\n` });
  });
  await page.route(/\/api\/ask$/, async (route) => {
    const answer = answerForPrompt(route.request().postDataJSON() as { prompt?: string });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer }) });
  });
}

test.beforeEach(async ({ page }) => {
  openedPr = null;
  await page.goto("/");
  await page.locator("input").first().fill(prUrl);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/pr/open") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Open" }).click();
  const response = await responsePromise;
  openedPr = (await response.json() as { pr: { key: string; headSha: string } }).pr;
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
});

test.afterEach(async ({ request }) => {
  if (openedPr == null) return;
  await request.post("/api/draft-review/save", { data: { prKey: openedPr.key, headSha: openedPr.headSha, event: "COMMENT", body: "", comments: [] } });
});

test("removes a previous PR from local history", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("**/api/pr/cleanup", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.getByRole("link", { name: "Home" }).click();
  const firstRow = page.locator(".pr-card").first();
  const key = await firstRow.locator(".pr-card-key").textContent();
  await firstRow.getByTitle("Remove saved PR and cleanup worktree").click();
  if (key != null) await expect(page.locator(".pr-card", { hasText: key })).toHaveCount(0);
});

test("reopens a previously loaded PR from the client cache", async ({ page }) => {
  let openRequests = 0;
  await page.route("**/api/pr/open", async (route) => {
    openRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "cache miss" }) });
  });

  await page.getByRole("link", { name: "Home" }).click();
  await page.locator(".pr-card").first().locator(".pr-card-body").click();

  await expect(page.locator(".review-layout")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Fully enable varlen split KV/ })).toBeVisible();
  await page.waitForTimeout(250);
  expect(openRequests).toBe(0);
});

test("opens a previous PR from its review link in a separate page", async ({ page, context }) => {
  await page.getByRole("link", { name: "Home" }).click();
  const href = await page.locator(".pr-card").first().locator(".pr-card-body").getAttribute("href");
  expect(href).toContain("#/review?pr=");

  const reviewPage = await context.newPage();
  await reviewPage.goto(new URL(href!, page.url()).toString());
  await expect(reviewPage.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
  await expect(reviewPage.getByRole("heading", { name: /Fully enable varlen split KV/ })).toBeVisible();
});

test("opens a PR and renders GitHub-style file diffs", async ({ page }) => {
  await expect(page.getByRole("heading", { name: /Fully enable varlen split KV/ })).toBeVisible();
  await expect.poll(() => page.locator(".file").count()).toBeGreaterThanOrEqual(2);
  await openFirstFile(page);
  await expect(page.locator(".diff-row.added").first()).toBeVisible();
});

test("shows GPU workspace MVP constraints for unsupported repos", async ({ page }) => {
  await openTools(page);
  await page.getByRole("menuitem", { name: "GPU workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "GPU workspace" });
  await expect(dialog.getByText("1 GPU", { exact: true })).toBeVisible();
  await expect(dialog.getByText("no persistent disk", { exact: true })).toBeVisible();
  await expect(dialog.getByText("15m TTL", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open GPU workspace" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Ask workspace agent" })).toBeDisabled();
  await expect(dialog.getByText("Dedicated Pi thread with the shared gpu_workspace tool")).toBeVisible();
  await expect(dialog.getByText("only supports pytorch/pytorch PR checkouts")).toBeVisible();
});

test("expands neighboring context lines", async ({ page }) => {
  await openFirstFile(page);
  const firstFile = page.locator(".file").first();
  const before = await firstFile.locator(".diff-row").count();
  await firstFile.getByRole("button", { name: "Expand lines above" }).first().click();
  await expect.poll(() => firstFile.locator(".diff-row").count()).toBeGreaterThan(before);
});

test("uses a compact files toolbar and collapsible review panel", async ({ page }) => {
  const toolbar = page.locator(".files-toolbar");
  await expect(toolbar).toContainText("Files");
  await expect(page.locator(".side")).toHaveCount(0);

  await openFirstFile(page);
  const firstFile = page.locator(".file").first();
  const rows = firstFile.locator(".diff-row");
  await rows.nth(Math.min(30, await rows.count() - 1)).evaluate((row) => row.scrollIntoView({ block: "center" }));
  const stickyPositions = await page.evaluate(() => {
    const toolbarRect = document.querySelector(".files-toolbar")!.getBoundingClientRect();
    const fileHeaderRect = document.querySelector(".file .file-summary")!.getBoundingClientRect();
    return { toolbarTop: toolbarRect.top, toolbarBottom: toolbarRect.bottom, fileHeaderTop: fileHeaderRect.top };
  });
  expect(stickyPositions.toolbarTop).toBeLessThanOrEqual(60);
  expect(stickyPositions.fileHeaderTop).toBeGreaterThanOrEqual(stickyPositions.toolbarBottom);
  await expect(firstFile.locator(".file-path")).toBeVisible();

  await toolbar.getByRole("button", { name: "Review changes" }).click();
  await expect(page.locator(".side")).toBeVisible();
  await expect(page.getByRole("button", { name: "Maximize side panel" })).toHaveCount(0);
  const emptyReviewSummary = page.locator(".review-summary-empty");
  await expect(emptyReviewSummary).toBeVisible();
  await emptyReviewSummary.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByPlaceholder("Overall review body")).toBeVisible();

  await page.getByRole("button", { name: "Hide review panel" }).click();
  await expect(page.locator(".side")).toHaveCount(0);
  await toolbar.getByRole("button", { name: /Pi review/ }).click();
  await expect(page.locator(".side")).toBeVisible();

  await toolbar.locator(".file-navigator > summary").click();
  await expect(toolbar.locator(".file-navigator-list")).toBeVisible();
});

test("keeps the files toolbar within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const toolbar = page.locator(".files-toolbar");
  await expect(toolbar).toBeVisible();
  expect(await toolbar.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
});

test("creates, edits, and removes draft comments", async ({ page }) => {
  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await page.locator(".inline-thread textarea").first().fill("first draft");
  await page.getByRole("button", { name: "Add draft comment" }).first().click();

  await expect(page.locator(".inline-thread.draft").first()).toContainText("first draft");
  await page.getByLabel("Edit draft").first().click();
  await page.locator(".draft-card textarea").first().fill("edited draft");
  await expect(page.locator(".inline-thread.draft").first()).toContainText("edited draft");

  await page.locator(".inline-thread.draft").first().getByLabel("Remove draft").click();
  await expect(page.locator(".inline-thread.draft")).toHaveCount(0);
});

test("pulls private GitHub comments and copies an agent handoff", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = Number(await row.getAttribute("data-line"));
  if (path == null || !Number.isFinite(line)) throw new Error("Missing diff target");
  const githubReview = { id: "pending-review", body: "", updatedAt: "now", comments: [{ id: "private-comment", path, line, startLine: null, subjectType: "LINE", body: "send this private note to the coding agent", url: "https://github.com/comment" }] };
  await page.route("**/api/github-draft-review/pull", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ review: githubReview }) });
  });

  await openSideTab(page, "Review");
  await page.getByRole("button", { name: "Pull private GitHub comments" }).click();

  await expect(page.locator(".github-draft-card")).toContainText(`${path}:${line}`);
  await expect(page.locator(".github-draft-card")).toContainText("send this private note to the coding agent");
  await page.getByRole("button", { name: "Copy agent handoff" }).click();
  await expect(page.getByRole("button", { name: "Copied agent handoff" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("private GitHub review drafts");
  expect(text).toContain(`${path}:${line}`);
  expect(text).toContain("send this private note to the coding agent");
});

test("saves a line comment immediately to a private GitHub review", async ({ page }) => {
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = Number(await row.getAttribute("data-line"));
  if (path == null || !Number.isFinite(line)) throw new Error("Missing diff target");
  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/github-draft-review/comment", async (route) => {
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ review: { id: "pending-review", body: "", updatedAt: "now", comments: [{ id: "private-comment", path, line, startLine: null, subjectType: "LINE", body: "private implementation note", url: "https://github.com/comment" }] } }) });
  });

  await row.click();
  await page.locator(".inline-thread textarea").first().fill("private implementation note");
  await page.getByRole("button", { name: "Save private on GitHub" }).click();

  await expect(page.locator(".inline-thread.local-thread")).toHaveCount(0);
  expect(payload).toMatchObject({ path, line, side: "RIGHT", body: "private implementation note" });
  await openSideTab(page, "Review");
  await expect(page.locator(".github-draft-card")).toContainText("private implementation note");
});

test("copies all draft comments with diff context", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await page.locator(".inline-thread textarea").first().fill("send this to another agent");
  await page.getByRole("button", { name: "Add draft comment" }).first().click();
  await openSideTab(page, "Review");
  await page.getByRole("button", { name: "Copy draft context" }).click();

  await expect(page.getByRole("button", { name: "Copied context" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("# PR review draft context");
  expect(text).toContain("send this to another agent");
  expect(text).toContain("Diff hunk context:\n```diff\n@@");
});

test("clears empty line threads when clicking elsewhere", async ({ page }) => {
  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await expect(page.locator(".inline-thread.local-thread")).toHaveCount(1);

  await page.locator(".pr-header-strip").click();
  await expect(page.locator(".inline-thread.local-thread")).toHaveCount(0);
});

test("supports multiline draft ranges", async ({ page }) => {
  const rows = await openFileWithAddedRows(page, 4);
  await rows.nth(0).scrollIntoViewIfNeeded();
  const firstLine = await rows.nth(0).getAttribute("data-line");
  const lastLine = await rows.nth(3).getAttribute("data-line");
  const start = await rows.nth(0).boundingBox();
  const end = await rows.nth(3).boundingBox();
  if (firstLine == null || lastLine == null || start == null || end == null) throw new Error("Missing drag row targets");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator(".inline-thread textarea").first().fill("range draft");
  await page.getByRole("button", { name: "Add draft comment" }).first().click();

  await expect(page.locator(".inline-thread.draft", { hasText: "range draft" })).toContainText(`${firstLine}-${lastLine}`);
  await openSideTab(page, "Review");
  await expect(page.getByRole("button", { name: /Submit review/ })).toBeEnabled();
});

test("clears the review form after submitting", async ({ page }) => {
  let submitRequests = 0;
  await page.route("**/api/review/submit", async (route) => {
    submitRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
  });

  await openReviewForm(page);
  await page.getByPlaceholder("Overall review body").fill("looks good");
  await page.getByRole("button", { name: /Submit review/ }).click();

  await expect(page.locator(".side")).toContainText("Review submitted.");
  await expect(page.getByPlaceholder("Overall review body")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start review" })).toBeVisible();
  expect(submitRequests).toBe(1);
});

test("shows failed review inline draft diagnostics", async ({ page }) => {
  let submitPayload: { comments?: Array<{ draft_id?: string; path?: string; line?: number; body?: string }> } | null = null;
  await page.route("**/api/review/submit", async (route) => {
    submitPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "gh: Unprocessable Entity (HTTP 422)\n\nInline comments in the failed review payload:\n1. draft=abc csrc/flash_attn/src/flash_fwd_kernel.h:1276 RIGHT — stale line draft\n\nIf GitHub returned HTTP 422, delete or recreate the listed draft whose path/line is stale, then retry." }),
    });
  });

  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await page.locator(".inline-thread textarea").first().fill("stale line draft");
  await page.getByRole("button", { name: "Add draft comment" }).first().click();
  await openSideTab(page, "Review");
  await page.getByRole("button", { name: /Submit review/ }).click();

  await expect(page.locator(".error")).toContainText("Inline comments in the failed review payload");
  await expect(page.locator(".error")).toContainText("stale line draft");
  await expect(page.locator(".error")).toContainText("delete or recreate the listed draft");
  expect(submitPayload?.comments?.[0].draft_id).toBeTruthy();
});

test("dragging diff rows opens a multiline thread", async ({ page }) => {
  const rows = await openFileWithAddedRows(page, 4);
  await rows.nth(0).scrollIntoViewIfNeeded();
  const firstLine = await rows.nth(0).getAttribute("data-line");
  const lastLine = await rows.nth(3).getAttribute("data-line");
  const start = await rows.nth(0).boundingBox();
  const end = await rows.nth(3).boundingBox();
  if (firstLine == null || lastLine == null || start == null || end == null) throw new Error("Missing drag row targets");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(".inline-thread.review-thread").first()).toContainText(`${firstLine}-${lastLine}`);
});

test("renders existing GitHub comments as markdown", async ({ page }) => {
  await openSideTab(page, "Comments");
  await expect(page.locator(".side .github-thread .markdown").first()).toContainText("Before #2448");
  await expect(page.locator(".side .github-thread pre code").first()).toContainText("set_params_splitkv");
});

test("edits an existing GitHub comment", async ({ page }) => {
  let editPayload: unknown = null;
  await page.route("**/api/comment/edit", async (route) => {
    editPayload = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
  });

  await openSideTab(page, "Comments");
  const firstThread = page.locator(".side .github-thread").first();
  await firstThread.getByRole("button", { name: "Edit" }).first().click();
  await firstThread.getByLabel("Edit comment").fill("edited from pi-review");
  await firstThread.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => editPayload).toMatchObject({ body: "edited from pi-review" });
  await expect(firstThread.locator(".markdown").first()).toContainText("edited from pi-review");
});

test("collapses and focuses existing comment threads", async ({ page }) => {
  await openSideTab(page, "Comments");
  const thread = page.locator(".side .github-thread").first();
  await expect(thread.locator(".markdown").first()).toBeVisible();
  await thread.getByLabel("Collapse thread").click();
  await expect(thread.locator(".markdown")).toHaveCount(0);
  await thread.getByLabel("Expand thread").click();
  await expect(thread.locator(".markdown").first()).toBeVisible();
});

test("switches GitHub-style themes", async ({ page }) => {
  await page.getByLabel("Theme").selectOption("github-light");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("github-light");
});

test("shows readable Pi diagnostics", async ({ page }) => {
  await page.route("**/api/pi/diagnostics", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ diagnostics: { prKey: "github.com/o/r#1", cwd: "/tmp/pr", sessionFile: "/tmp/session.jsonl", sessionId: "abc", model: "anthropic/claude", thinkingLevel: "medium", activeTools: ["read", "bash"], availableModels: [{ provider: "anthropic", id: "claude" }], tools: [{ name: "read" }], lastPrompt: { chars: 42, startedAt: "now", preview: "Review this PR" }, sessions: [{ purpose: "inline-chat", ready: true, queued: false, promptState: { status: "running", elapsedMs: 12000, chars: 42, answerChars: 0 }, lastPrompt: { preview: "Inline question" } }] } }),
    });
  });

  await openTools(page);
  await page.getByRole("menuitem", { name: "Session diagnostics" }).click();
  await expect(page.getByRole("heading", { name: "Pi diagnostics" })).toBeVisible();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("strong", { hasText: "anthropic/claude" })).toBeVisible();
  await expect(dialog.locator("dd", { hasText: "/tmp/pr" })).toBeVisible();
  await expect(dialog.locator(".prompt-preview", { hasText: "Review this PR" })).toBeVisible();
  await expect(dialog).toContainText("Pi runs");
  await expect(dialog).toContainText("inline-chat · ready");
  await expect(dialog).toContainText("running · 12s");
});

test("renders inline Ask Pi responses as markdown", async ({ page }) => {
  let prompt = "";
  await mockAskPi(page, (body) => {
    prompt = body.prompt ?? "";
    return "**Finding:** check `batch_offset`.\n\n```cpp\nreturn batch_offset;\n```";
  });

  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await page.locator(".inline-thread textarea").first().fill("review this line");
  await page.getByRole("button", { name: "Ask Pi" }).first().click();

  const thread = page.locator(".local-comment-timeline").first();
  await expect(thread).toContainText("Finding:");
  await expect(thread.locator("pre code")).toContainText("return batch_offset;");
  expect(prompt).toContain("Diff hunk context:\n@@");
  expect(prompt).toContain("review this line");
});

test("selects diff code text without opening a thread", async ({ page }) => {
  await openFirstFile(page);
  const code = page.locator(".file").first().locator(".diff-row.added code").first();
  await expect(code).toBeVisible();
  await code.selectText();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toEqual("");
  await expect(page.locator(".inline-thread")).toHaveCount(0);
});

test("opens code-wrapped file references in VS Code", async ({ page }) => {
  await openFirstFile(page);
  const row = page.locator(".file").first().locator(".diff-row.added").first();
  const path = await row.getAttribute("data-path");
  const line = await row.getAttribute("data-line");
  if (path == null || line == null) throw new Error("Missing diff row target");
  await mockAskPi(page, () => `Check \`${path}:${line} — suspicious location\`.`);
  let openPayload: { path?: string; line?: number } | null = null;
  await page.route("**/api/file/open", async (route) => {
    openPayload = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ target: "/tmp/file" }) });
  });

  await row.click();
  await page.locator(".inline-thread textarea").first().fill("where is this?");
  await page.getByRole("button", { name: "Ask Pi" }).first().click();
  await page.locator(".local-comment-timeline .file-reference-link").first().click();

  await expect.poll(() => openPayload).toMatchObject({ path, line: Number.parseInt(line, 10) });
});

test("runs a separate focus areas review and highlights referenced lines", async ({ page }) => {
  await openFirstFile(page);
  const row = page.locator(".file").first().locator(".diff-row.added").first();
  const path = await row.getAttribute("data-path");
  const line = await row.getAttribute("data-line");
  if (path == null || line == null) throw new Error("Missing diff row target");
  await page.locator(".file").first().locator(".file-summary-left").click();
  await expect(page.locator(".file").first().locator(".diff-row")).toHaveCount(0);

  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: `## Focus areas\n1. convention mismatch\n- ${path}:${line}-${Number.parseInt(line, 10) + 1} — check whether this matches local tiling conventions.` } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "focus-job" } }) });
  });

  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: "Focus scan" }).click();

  const focusArea = page.locator(".focus-area-inline");
  await expect(focusArea).toContainText("tiling conventions");
  await focusArea.getByRole("button", { name: "Collapse" }).click();
  await expect(page.locator(".focus-area-collapsed")).toBeVisible();
  await page.locator(".focus-area-collapsed").click();
  await expect(focusArea).toContainText("tiling conventions");
  await focusArea.getByPlaceholder("Write a draft comment or ask Pi about this focus area").fill("please check this tradeoff");
  await focusArea.getByRole("button", { name: "Add draft comment" }).click();
  await expect(page.locator(".inline-thread.draft")).toContainText("please check this tradeoff");
  await openSideTab(page, "Review");
  await expect(page.getByRole("button", { name: /Submit review/ })).toBeEnabled();
  await openSideTab(page, "Pi");
  await expect(page.locator(".ai-review")).toContainText("0/1 focus area reviewed");
  await expect(row).toHaveClass(/focus-highlight-active/);
});

test("marking a file viewed collapses it without jumping to the active focus area", async ({ page }) => {
  const focusRow = (await openFileWithAddedRows(page, 1)).first();
  const focusPath = await focusRow.getAttribute("data-path");
  const focusLine = await focusRow.getAttribute("data-line");
  if (focusPath == null || focusLine == null) throw new Error("Missing focus row target");
  const focusFile = focusRow.locator("xpath=ancestor::section[contains(concat(' ', normalize-space(@class), ' '), ' file ')][1]");
  await focusFile.locator(".file-summary-left").click();
  await expect(focusFile.locator(".diff-row")).toHaveCount(0);

  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: `## Focus areas\n1. active finding\n- ${focusPath}:${focusLine}-${Number.parseInt(focusLine, 10) + 1} — check this line.` } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "focus-no-jump-job" } }) });
  });
  await page.route("**/api/focus-scan/save", async (route) => {
    const request = route.request().postDataJSON() as { prKey: string; headSha: string; answer: string; areaStates: Record<string, unknown> };
    const now = new Date().toISOString();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ scan: { id: "focus-no-jump-scan", ...request, createdAt: now, updatedAt: now } }) });
  });
  await page.route("**/api/file/viewed", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: /Focus scan|Refresh focus scan/ }).click();
  const focusLink = page.locator(".focus-area-link-row button").first();
  await expect(focusLink).toContainText("check this line");
  await focusLink.click();
  await expect(focusRow).toHaveClass(/focus-highlight-active/);

  const files = page.locator(".file");
  let otherFileIndex = -1;
  for (let index = 0; index < await files.count(); index += 1) {
    if (await files.nth(index).locator(".file-path").textContent() !== focusPath) {
      otherFileIndex = index;
      break;
    }
  }
  expect(otherFileIndex).toBeGreaterThanOrEqual(0);
  const otherFile = files.nth(otherFileIndex);
  if (await otherFile.locator(".diff-row").count() === 0) await otherFile.locator(".file-summary-left").click();
  await expect(otherFile.locator(".diff-row").first()).toBeVisible();
  await otherFile.locator(".viewed-toggle input").scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const state = window as typeof window & { scrollIntoViewCalls: number };
    state.scrollIntoViewCalls = 0;
    Element.prototype.scrollIntoView = () => { state.scrollIntoViewCalls += 1; };
  });

  await otherFile.locator(".viewed-toggle input").click();
  await expect(otherFile.locator(".diff-row")).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { scrollIntoViewCalls: number }).scrollIntoViewCalls)).toBe(0);
});

test("minimizes focus area links after all are reviewed", async ({ page }) => {
  const rows = await openFileWithAddedRows(page, 2);
  const firstPath = await rows.nth(0).getAttribute("data-path");
  const firstLine = await rows.nth(0).getAttribute("data-line");
  const secondPath = await rows.nth(1).getAttribute("data-path");
  const secondLine = await rows.nth(1).getAttribute("data-line");
  if (firstPath == null || firstLine == null || secondPath == null || secondLine == null) throw new Error("Missing diff row targets");

  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: `## Focus areas\n1. first finding\n- ${firstPath}:${firstLine} — check first.\n2. second finding\n- ${secondPath}:${secondLine} — check second.` } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "focus-minimize-job" } }) });
  });
  await page.route("**/api/focus-scan/save", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ scan: { id: "focus-minimize-scan" } }) });
  });

  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: "Focus scan" }).click();
  await expect(page.locator(".focus-area-link-row")).toHaveCount(2);
  await page.locator(".focus-area-check input").nth(0).click();
  await page.locator(".focus-area-check input").nth(1).click();

  await expect(page.locator(".focus-area-links")).toContainText("2/2 focus areas reviewed");
  await expect(page.locator(".focus-area-link-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.locator(".focus-area-link-row")).toHaveCount(2);
});

test("shows a clean focus scan status when there are no focus areas", async ({ page }) => {
  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: "No focus areas found. All good." } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "clean-focus-job" } }) });
  });

  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: "Focus scan" }).click();

  await expect(page.locator(".ai-review")).toContainText("Focus scan clean");
  await expect(page.locator(".focus-area-inline")).toHaveCount(0);
});

test("persists Pi review chat across page reloads", async ({ page }) => {
  await page.route(/\/api\/pi\/review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: "Initial review." } }) });
  });
  await mockAskPi(page, () => "Persisted answer about `cu_seqlens_q`.");

  await openSideTab(page, "Pi");
  await page.locator(".ai-review").getByPlaceholder("Ask Pi about this PR…").fill("remember this conversation");
  await expect(page.locator(".ai-review").getByRole("button", { name: "Send" })).toBeEnabled();
  await Promise.all([
    page.waitForResponse(/\/api\/ai-review\/save$/),
    page.locator(".ai-review").getByPlaceholder("Ask Pi about this PR…").press("Enter"),
  ]);
  await expect(page.locator(".ai-review")).toContainText("remember this conversation");
  await expect(page.locator(".ai-review")).toContainText("Persisted answer");

  await page.reload();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
  await openSideTab(page, "Pi");

  await expect(page.locator(".ai-review")).toContainText("remember this conversation");
  await expect(page.locator(".ai-review")).toContainText("Persisted answer");
});

test("opens a separate code walk modal from the toolbar", async ({ page }) => {
  let prompt = "";
  await mockAskPi(page, (body) => {
    prompt = body.prompt ?? "";
    return `# PR goal

Orient reviewers.

## Walk map

\`\`\`mermaid
flowchart LR
  Toolbar --> Modal
\`\`\`

## Key code patterns

| Pattern | Where | Why it matters |
| --- | --- | --- |
| Panel modal | \`csrc/flash_attn/src/flash_fwd_kernel.h:1276\` | Keeps history quiet |

## Code walk

See \`csrc/flash_attn/src/flash_fwd_kernel.h:1276\`.

\`\`\`tsx
<Button>Code walk</Button>
\`\`\`

## What changed in behavior

The walk is separate from review chat.`;
  });

  await page.setViewportSize({ width: 320, height: 667 });
  await openTools(page);
  await page.getByRole("menuitem", { name: "Code walk" }).click();

  const dialog = page.getByRole("dialog", { name: "Code walk" });
  await expect(dialog).toContainText("Walk map");
  await expect(dialog.locator(".markdown-mermaid-block")).toBeVisible();
  await expect(dialog.locator("table")).toContainText("Why it matters");
  await expect(dialog.getByRole("button", { name: "Standard DPI" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Expand" }).click();
  await expect(dialog).toHaveClass(/expanded/);
  await expect(dialog.getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
  await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(prompt).toContain("reviewer-friendly code walk");
  expect(prompt).toContain("Walk map");
});

test("runs the right-sidebar Pi review panel and continues the chat with Enter", async ({ page }) => {
  let openedFile: unknown = null;
  await page.route(/\/api\/file\/open$/, async (route) => {
    openedFile = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ target: "opened" }) });
  });
  let reviewAnswer = "- **Correctness:** inspect `csrc/flash_attn/src/flash_fwd_kernel.h:1276`.";
  await page.route(/\/api\/pi\/review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: reviewAnswer } }) });
  });
  await page.route(/\/api\/pi\/review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "review-job" } }) });
  });
  await mockAskPi(page, (body) => body.prompt?.includes("latest question") ? "Follow-up answer about `cu_seqlens_q`." : "Unexpected ask response");

  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: /Full review|Refresh findings/ }).click();

  const dialog = page.locator(".ai-review");
  await expect(dialog).toContainText("Correctness:");
  await expect(dialog.locator(".file-snippet")).toHaveCount(0);
  await Promise.all([
    page.waitForRequest(/\/api\/file\/open$/),
    dialog.getByRole("link", { name: "csrc/flash_attn/src/flash_fwd_kernel.h:1276" }).click(),
  ]);
  expect(openedFile).toMatchObject({ path: "csrc/flash_attn/src/flash_fwd_kernel.h", line: 1276 });
  await expect(dialog.getByText("General review")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Refresh findings" })).toBeEnabled();
  reviewAnswer = "- **Tests:** rerun the CUDA smoke test.";
  await dialog.getByRole("button", { name: "Refresh findings" }).click();
  await expect(dialog.getByText("CUDA smoke test")).toBeVisible();
  await expect(dialog).not.toContainText("Correctness:");
  await expect(dialog.getByText("General review")).toHaveCount(1);
  await dialog.getByPlaceholder("Ask Pi about this PR…").fill("what should I test?");
  await dialog.getByPlaceholder("Ask Pi about this PR…").press("Enter");
  await expect(dialog).toContainText("Follow-up answer");
});

test("shows Pi-created review comments as editable local drafts", async ({ page }) => {
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = await row.getAttribute("data-line");
  if (path == null || line == null || openedPr == null) throw new Error("Missing draft target");
  const body = "Could this preserve the previous behavior for empty inputs?";

  await page.route("**/api/draft-review/get", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ draftReview: { prKey: openedPr!.key, headSha: openedPr!.headSha, event: "COMMENT", body: "", comments: [{ id: "pi-e2e-draft", path, line: Number.parseInt(line, 10), side: "RIGHT", body }], updatedAt: "now" } }) });
  });
  await mockAskPi(page, () => "I added that as a private draft comment.");

  await openSideTab(page, "Pi");
  const panel = page.locator(".ai-review");
  await panel.getByPlaceholder("Ask Pi about this PR…").fill("Draft a review comment for the empty-input concern.");
  await panel.getByPlaceholder("Ask Pi about this PR…").press("Enter");

  const draft = page.locator(".inline-thread.draft", { hasText: body });
  await expect(draft).toBeVisible();
  await draft.getByRole("button", { name: "Edit draft" }).click();
  const editor = page.locator(".inline-thread.draft textarea").first();
  await expect(editor).toHaveValue(body);
  await editor.fill("Edited model draft.");
  await expect(editor).toHaveValue("Edited model draft.");
});

test("copies local draft comments in a feedback prompt from the Review tab", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const rows = await openFileWithAddedRows(page, 1);
  const path = await rows.first().getAttribute("data-path");
  const line = await rows.first().getAttribute("data-line");
  if (path == null || line == null) throw new Error("Missing diff row target");
  const lineNumber = Number.parseInt(line, 10);
  let feedbackPayload: Record<string, unknown> | null = null;

  await page.route("**/api/pi/prompt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.mode === "review-feedback") {
      feedbackPayload = body;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ prompt: "COPIED REVIEW FEEDBACK PROMPT", purpose: "review-feedback" }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ prompt: `prompt for ${String(body.mode)}`, purpose: String(body.mode) }) });
  });
  await page.route(/\/api\/pi\/review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: "Global feedback from Pi." } }) });
  });
  await page.route(/\/api\/pi\/review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "copy-review-job" } }) });
  });
  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: `## Focus areas\n- ${path}:${line} — copied focus area\nCheck this focused spot.` } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "copy-focus-job" } }) });
  });
  await mockAskPi(page, () => "AI chat answer.");

  await rows.first().click();
  await page.locator(".inline-thread textarea").first().fill("Keep this local feedback out of GitHub.");
  await page.getByRole("button", { name: "Add draft comment" }).first().click();
  await expect(page.locator(".inline-thread.draft")).toContainText("Keep this local feedback out of GitHub.");

  await openSideTab(page, "Pi");
  const panel = page.locator(".ai-review");
  await panel.getByRole("button", { name: /Full review|Refresh findings/ }).click();
  await expect(panel).toContainText("Global feedback from Pi");
  await panel.getByRole("button", { name: /Focus scan|Refresh focus scan/ }).click();
  await expect(panel).toContainText("copied focus area");
  await panel.getByPlaceholder("Ask Pi about this PR…").fill("What should I prioritize?");
  await panel.getByPlaceholder("Ask Pi about this PR…").press("Enter");
  await expect(panel).toContainText("AI chat answer");
  await openSideTab(page, "Review");
  const reviewPanel = page.locator(".side .panel");
  const finalDraftSave = page.waitForResponse((response) => response.url().endsWith("/api/draft-review/save") && (response.request().postDataJSON() as { body?: string }).body === "Keep this overall note local too.");
  await reviewPanel.getByPlaceholder("Overall review body").fill("Keep this overall note local too.");
  await finalDraftSave;
  await reviewPanel.getByRole("button", { name: "Copy feedback prompt" }).click();

  await expect(reviewPanel.getByRole("button", { name: "Copied feedback prompt" })).toBeVisible();
  await expect(reviewPanel.locator(".draft-card")).toContainText("Keep this local feedback out of GitHub.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("COPIED REVIEW FEEDBACK PROMPT");
  await expect.poll(() => feedbackPayload?.mode).toBe("review-feedback");
  const userComments = feedbackPayload?.userComments as Array<{ body?: string }> | undefined;
  const aiComments = feedbackPayload?.aiComments as Array<{ role?: string; text?: string }> | undefined;
  const focusAreas = feedbackPayload?.focusAreas as Array<{ path?: string; startLine?: number; title?: string }> | undefined;
  expect(userComments?.some((comment) => comment.body === "Keep this overall note local too.")).toBe(true);
  expect(userComments?.some((comment) => comment.body === "Keep this local feedback out of GitHub.")).toBe(true);
  expect(userComments?.some((comment) => comment.body?.includes("Before #2448"))).toBe(true);
  expect(aiComments?.some((comment) => comment.role === "user" && comment.text === "What should I prioritize?")).toBe(true);
  expect(aiComments?.some((comment) => comment.role === "pi" && comment.text === "AI chat answer.")).toBe(true);
  expect(focusAreas?.[0]).toMatchObject({ path, startLine: lineNumber, title: "copied focus area" });
  expect(feedbackPayload?.globalFeedback).toBe("Global feedback from Pi.");

  await page.reload();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
  await openSideTab(page, "Review");
  await expect(page.locator(".side .draft-card")).toContainText("Keep this local feedback out of GitHub.");
  await expect(page.getByPlaceholder("Overall review body")).toHaveValue("Keep this overall note local too.");
});
