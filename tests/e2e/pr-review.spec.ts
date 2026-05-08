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

test("runs the right-sidebar Pi review panel with markdown output", async ({ page }) => {
  await page.route("**/api/ask", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ answer: "- **Correctness:** inspect `cu_seqlens_q`." }),
    });
  });

  await page.getByRole("button", { name: "Run review" }).click();

  const panel = page.locator(".ai-review");
  await expect(panel).toContainText("Correctness:");
  await expect(panel.getByRole("button", { name: "Run again" })).toBeEnabled();
});
