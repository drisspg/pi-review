import { expect, test, type Page } from "@playwright/test";

const prUrl = process.env.PI_REVIEW_TEST_PR ?? "https://github.com/Dao-AILab/flash-attention/pull/2542";

async function openFirstFile(page: Page) {
  const firstFile = page.locator(".file").first();
  if (await firstFile.locator(".diff-row").count() === 0) await firstFile.getByRole("button", { name: /Expand/ }).click();
  await expect(firstFile.locator(".diff-row").first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("OWNER/REPO#123 or GitHub PR URL").fill(prUrl);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
});

test("removes a previous PR from local history", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.route("**/api/pr/cleanup", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.getByRole("button", { name: "Home" }).click();
  const firstRow = page.locator(".history-row").first();
  const key = await firstRow.locator("span").textContent();
  await firstRow.getByTitle("Remove saved PR and cleanup worktree").click();
  if (key != null) await expect(page.locator(".history-row", { hasText: key.split(" · ")[0] })).toHaveCount(0);
});

test("opens a PR and renders GitHub-style file diffs", async ({ page }) => {
  await expect(page.getByText("fix address access for varlen attn split kv").first()).toBeVisible();
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
  await page.getByTitle("Edit draft").first().click();
  await page.locator(".draft-card textarea").first().fill("edited draft");
  await expect(page.locator(".inline-thread.draft").first()).toContainText("edited draft");

  await page.locator(".inline-thread.draft").first().getByRole("button", { name: "Remove" }).click();
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

test("dragging diff rows opens a multiline thread", async ({ page }) => {
  await openFirstFile(page);
  const rows = page.locator(".file").first().locator(".diff-row.added");
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
  await expect(page.locator(".comment .markdown").first()).toContainText("Before #2448");
  await expect(page.locator(".comment pre code").first()).toContainText("set_params_splitkv");
});

test("collapses and focuses existing comment threads", async ({ page }) => {
  const thread = page.locator(".comment.github-thread").first();
  await expect(thread.locator(".markdown").first()).toBeVisible();
  await thread.getByLabel("Collapse thread").click();
  await expect(thread.locator(".markdown")).toHaveCount(0);
  await thread.getByLabel("Expand thread").click();
  await expect(thread.locator(".markdown").first()).toBeVisible();
  await thread.getByLabel("Focus thread").click();
  await expect(page.getByRole("dialog")).toContainText("Conversation thread");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("switches GitHub-style themes", async ({ page }) => {
  await page.getByLabel("Theme").selectOption("github-light");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("github-light");
});

test("shows readable Pi diagnostics", async ({ page }) => {
  await page.route("**/api/pi/diagnostics", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ diagnostics: { prKey: "github.com/o/r#1", cwd: "/tmp/pr", sessionFile: "/tmp/session.jsonl", sessionId: "abc", model: "anthropic/claude", thinkingLevel: "medium", activeTools: ["read", "bash"], availableModels: [{ provider: "anthropic", id: "claude" }], tools: [{ name: "read" }], lastPrompt: { chars: 42, startedAt: "now", preview: "Review this PR" } } }),
    });
  });

  await page.getByTitle("Pi session diagnostics").click();
  await expect(page.getByRole("heading", { name: "Pi diagnostics" })).toBeVisible();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("strong", { hasText: "anthropic/claude" })).toBeVisible();
  await expect(dialog.locator("dd", { hasText: "/tmp/pr" })).toBeVisible();
  await expect(dialog.locator(".prompt-preview", { hasText: "Review this PR" })).toBeVisible();
});

test("renders inline Ask Pi responses as markdown", async ({ page }) => {
  await page.route("**/api/ask", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: "**Finding:** check `batch_offset`.\n\n```cpp\nreturn batch_offset;\n```" }),
    });
  });

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

  await page.route("**/api/pi/focus-review", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: `## Focus areas\n- \`${path}:${line}-${Number.parseInt(line, 10) + 1} — convention mismatch\`: check whether this matches local tiling conventions.` }),
    });
  });

  await page.getByRole("button", { name: "Focus scan" }).click();

  const focusArea = page.locator(".focus-area-inline");
  await expect(focusArea).toContainText("tiling conventions");
  await focusArea.getByRole("button", { name: "Collapse" }).click();
  await expect(focusArea).toHaveClass(/collapsed/);
  await focusArea.getByRole("button", { name: "Expand" }).click();
  await expect(focusArea).toContainText("tiling conventions");
  await expect(page.locator(".ai-review")).toContainText("1 focus area highlighted inline");
  await expect(row).toHaveClass(/focus-highlight-active/);
});

test("runs the right-sidebar Pi review panel and continues the chat with Enter", async ({ page }) => {
  await page.route("**/api/ask", async (route) => {
    const body = route.request().postDataJSON() as { prompt?: string };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: body.prompt?.includes("latest question") ? "Follow-up answer about `cu_seqlens_q`." : "- **Correctness:** inspect `cu_seqlens_q`." }),
    });
  });

  await page.getByRole("button", { name: "Run review" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Correctness:");
  await expect(dialog.getByRole("button", { name: "Run again" })).toBeEnabled();
  await dialog.getByPlaceholder("Ask Pi about this PR…").fill("what should I test?");
  await dialog.getByPlaceholder("Ask Pi about this PR…").press("Enter");
  await expect(dialog).toContainText("Follow-up answer");
});
