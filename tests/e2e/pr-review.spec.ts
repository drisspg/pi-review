import { expect, test, type Page } from "@playwright/test";

const prUrl = process.env.PI_REVIEW_TEST_PR ?? "https://github.com/Dao-AILab/flash-attention/pull/2542";

async function openFirstFile(page: Page) {
  const firstFile = page.locator(".file").first();
  if (await firstFile.locator(".diff-row").count() === 0) await firstFile.locator(".file-summary-left").click();
  await expect(firstFile.locator(".diff-row").first()).toBeVisible();
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
  await page.goto("/");
  await page.locator("input").first().fill(prUrl);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
});

test("removes a previous PR from local history", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("**/api/pr/cleanup", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.getByRole("button", { name: "Home" }).click();
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

  await page.getByRole("button", { name: "Home" }).click();
  await page.locator(".pr-card").first().locator(".pr-card-body").click();

  await expect(page.locator(".review-layout")).toBeVisible();
  await expect(page.getByText("github.com/Dao-AILab/flash-attention#2542").first()).toBeVisible();
  await page.waitForTimeout(250);
  expect(openRequests).toBe(0);
});

test("opens a PR and renders GitHub-style file diffs", async ({ page }) => {
  await expect(page.getByText("github.com/Dao-AILab/flash-attention#2542").first()).toBeVisible();
  await expect(page.locator(".file")).toHaveCount(2);
  await openFirstFile(page);
  await expect(page.locator(".diff-row.added").first()).toBeVisible();
});

test("expands neighboring context lines", async ({ page }) => {
  await openFirstFile(page);
  const firstFile = page.locator(".file").first();
  const before = await firstFile.locator(".diff-row").count();
  await firstFile.getByRole("button", { name: "Expand above" }).first().click();
  await expect.poll(() => firstFile.locator(".diff-row").count()).toBeGreaterThan(before);
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

test("clears empty line threads when clicking elsewhere", async ({ page }) => {
  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await expect(page.locator(".inline-thread")).toHaveCount(1);

  await page.locator(".side").click();
  await expect(page.locator(".inline-thread")).toHaveCount(0);
});

test("supports multiline draft ranges", async ({ page }) => {
  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  const rangeEnd = page.locator(".range-control input").first();
  await rangeEnd.fill("1279");
  await page.locator(".inline-thread textarea").first().fill("range draft");
  await page.getByRole("button", { name: "Add draft comment" }).first().click();

  await expect(page.locator(".inline-thread.draft").first()).toContainText("1276-1279");
  await expect(page.getByRole("button", { name: "Submit review (1)" })).toBeEnabled();
});

test("clears the review form after submitting", async ({ page }) => {
  let submitRequests = 0;
  await page.route("**/api/review/submit", async (route) => {
    submitRequests += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
  });

  await page.getByPlaceholder("Overall review body").fill("looks good");
  await page.getByRole("button", { name: "Submit review (0)" }).click();

  await expect(page.getByRole("button", { name: "Review submitted" })).toBeDisabled();
  await expect(page.getByPlaceholder("Overall review body")).toHaveValue("");
  await expect(page.locator(".side")).toContainText("Review submitted.");
  expect(submitRequests).toBe(1);
});

test("dragging diff rows opens a multiline thread", async ({ page }) => {
  await openFirstFile(page);
  const rows = page.locator(".file").first().locator(".diff-row.added");
  await rows.nth(0).scrollIntoViewIfNeeded();
  const start = await rows.nth(0).boundingBox();
  const end = await rows.nth(3).boundingBox();
  if (start == null || end == null) throw new Error("Missing drag row boxes");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(".inline-thread.review-thread").first()).toContainText("1276-1279");
});

test("renders existing GitHub comments as markdown", async ({ page }) => {
  await page.getByRole("tab", { name: /Comments/ }).click();
  await expect(page.locator(".side .github-thread .markdown").first()).toContainText("Before #2448");
  await expect(page.locator(".side .github-thread pre code").first()).toContainText("set_params_splitkv");
});

test("edits an existing GitHub comment", async ({ page }) => {
  let editPayload: unknown = null;
  await page.route("**/api/comment/edit", async (route) => {
    editPayload = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { ok: true } }) });
  });

  await page.getByRole("tab", { name: /Comments/ }).click();
  const firstThread = page.locator(".side .github-thread").first();
  await firstThread.getByRole("button", { name: "Edit" }).first().click();
  await firstThread.getByLabel("Edit comment").fill("edited from pi-review");
  await firstThread.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => editPayload).toMatchObject({ body: "edited from pi-review" });
  await expect(firstThread.locator(".markdown").first()).toContainText("edited from pi-review");
});

test("collapses and focuses existing comment threads", async ({ page }) => {
  await page.getByRole("tab", { name: /Comments/ }).click();
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

  await page.getByTitle("Pi session diagnostics").click();
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
  await mockAskPi(page, () => "**Finding:** check `batch_offset`.\n\n```cpp\nreturn batch_offset;\n```");

  await openFirstFile(page);
  await page.locator(".file").first().locator(".diff-row.added").first().click();
  await page.locator(".inline-thread textarea").first().fill("review this line");
  await page.getByRole("button", { name: "Ask Pi" }).first().click();

  const thread = page.locator(".thread-messages").first();
  await expect(thread).toContainText("Finding:");
  await expect(thread.locator("pre code")).toContainText("return batch_offset;");
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

  await page.getByRole("tab", { name: "Pi" }).click();
  await page.getByRole("button", { name: "Focus scan" }).click();

  const focusArea = page.locator(".focus-area-inline");
  await expect(focusArea).toContainText("tiling conventions");
  await focusArea.getByRole("button", { name: "Collapse" }).click();
  await expect(page.locator(".focus-area-collapsed")).toBeVisible();
  await page.locator(".focus-area-collapsed").click();
  await expect(focusArea).toContainText("tiling conventions");
  await focusArea.getByPlaceholder("Ask Pi or write a draft comment about this focus area").fill("please check this tradeoff");
  await focusArea.getByRole("button", { name: "Add draft comment" }).click();
  await expect(page.locator(".inline-thread.draft")).toContainText("please check this tradeoff");
  await page.getByRole("tab", { name: /Review/ }).click();
  await expect(page.getByRole("button", { name: "Submit review (1)" })).toBeEnabled();
  await page.getByRole("tab", { name: "Pi" }).click();
  await expect(page.locator(".ai-review")).toContainText("0/1 focus area reviewed");
  await expect(row).toHaveClass(/focus-highlight-active/);
});

test("shows a clean focus scan status when there are no focus areas", async ({ page }) => {
  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: "No focus areas found. All good." } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "clean-focus-job" } }) });
  });

  await page.getByRole("tab", { name: "Pi" }).click();
  await page.getByRole("button", { name: "Focus scan" }).click();

  await expect(page.locator(".ai-review")).toContainText("Focus scan clean");
  await expect(page.locator(".focus-area-inline")).toHaveCount(0);
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

  await page.getByRole("tab", { name: "Pi" }).click();
  await page.getByRole("button", { name: /Full review|Refresh findings/ }).click();

  const dialog = page.locator(".ai-review");
  await expect(dialog).toContainText("Correctness:");
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
