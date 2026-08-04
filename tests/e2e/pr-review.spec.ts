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

async function mockAskPi(page: Page, answerForPrompt: (body: { prompt?: string }) => string, sessionEventsForPrompt?: (body: { prompt?: string }) => Record<string, unknown>[]) {
  await page.route(/\/api\/ask\/stream$/, async (route) => {
    const request = route.request().postDataJSON() as { prompt?: string };
    const answer = answerForPrompt(request);
    const sessionEvents = (sessionEventsForPrompt?.(request) ?? []).map((event) => `event: session\ndata: ${JSON.stringify(event)}\n\n`).join("");
    await route.fulfill({ contentType: "text/event-stream", body: `${sessionEvents}event: delta\ndata: ${JSON.stringify({ delta: answer })}\n\nevent: done\ndata: ${JSON.stringify({ answer })}\n\n` });
  });
  await page.route(/\/api\/ask$/, async (route) => {
    const answer = answerForPrompt(route.request().postDataJSON() as { prompt?: string });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer }) });
  });
}

async function mockNativeTerminal(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const terminalMessages: string[] = [];
    Object.assign(window, { __terminalMessages: terminalMessages });
    class MockTerminalWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = MockTerminalWebSocket.CONNECTING;
      constructor() {
        super();
        Object.assign(window, { __terminalSocket: this });
        window.setTimeout(() => {
          this.readyState = MockTerminalWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ready", pid: 42 }) }));
          window.setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "output", data: "\u001b[32mNative Pi ready\u001b[0m\r\n" }) })), 50);
        }, 50);
      }
      send(message: string) { terminalMessages.push(message); }
      close() {
        this.readyState = MockTerminalWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: MockTerminalWebSocket });
  });
  return () => page.evaluate(() => (window as unknown as { __terminalMessages: string[] }).__terminalMessages);
}

async function emitNativeTerminalMessage(page: Page, message: Record<string, unknown>) {
  await page.evaluate((payload) => {
    const socket = (window as unknown as { __terminalSocket: EventTarget }).__terminalSocket;
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }, message);
}

async function loadDraftReviewFromTerminal(page: Page, comments: Array<{ id: string; path: string; line: number; startLine?: number; side: "RIGHT" | "LEFT"; body: string }>, body = "") {
  if (openedPr == null) throw new Error("Missing opened PR");
  await mockNativeTerminal(page);
  await openSideTab(page, "Pi");
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeVisible();
  await emitNativeTerminalMessage(page, { type: "draftReview", draftReview: { prKey: openedPr.key, headSha: openedPr.headSha, event: "COMMENT", body, comments, updatedAt: "now" } });
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

test("selects and removes multiple previous PRs", async ({ page }) => {
  const savedPrs = [
    { key: "github.com/example/repo#1", title: "First saved PR", url: "https://github.com/example/repo/pull/1", headSha: "111111111111", lastOpenedAt: "2026-07-23T03:00:00.000Z", filesChanged: 1, existingCommentCount: 0 },
    { key: "github.com/example/repo#2", title: "Second saved PR", url: "https://github.com/example/repo/pull/2", headSha: "222222222222", lastOpenedAt: "2026-07-23T02:00:00.000Z", filesChanged: 2, existingCommentCount: 1 },
    { key: "github.com/example/repo#3", title: "Keep this PR", url: "https://github.com/example/repo/pull/3", headSha: "333333333333", lastOpenedAt: "2026-07-23T01:00:00.000Z", filesChanged: 3, existingCommentCount: 2 },
  ];
  const cleanupInputs: string[] = [];
  const dialogs: string[] = [];
  let activeCleanups = 0;
  let maxActiveCleanups = 0;
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await page.route("**/api/prs", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ prs: savedPrs }) });
  });
  await page.route("**/api/pr/cleanup", async (route) => {
    cleanupInputs.push((route.request().postDataJSON() as { input: string }).input);
    activeCleanups += 1;
    maxActiveCleanups = Math.max(maxActiveCleanups, activeCleanups);
    await new Promise((resolve) => setTimeout(resolve, 25));
    activeCleanups -= 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/");
  await expect(page.locator(".pr-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByLabel("Select github.com/example/repo#1").check();
  await page.getByLabel("Select github.com/example/repo#2").check();
  await page.getByRole("button", { name: "Delete selected (2)" }).click();

  await expect(page.locator(".pr-card")).toHaveCount(1);
  await expect(page.locator(".pr-card")).toContainText("Keep this PR");
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  expect(cleanupInputs).toEqual(savedPrs.slice(0, 2).map((pr) => pr.url));
  expect(maxActiveCleanups).toBe(1);
  expect(dialogs).toEqual(["Remove 2 saved PRs from history and delete their local worktree/session caches?"]);
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

test("can cancel a slow pull request open", async ({ page }) => {
  await page.getByRole("link", { name: "Home" }).click();
  await page.route("**/api/pr/open", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.abort();
  });

  await page.locator("input").first().fill("https://github.com/example/repo/pull/999");
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("heading", { name: "Review a pull request" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
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

test("refresh updates pull request activity and landed status", async ({ page }) => {
  await page.route("**/api/pr/activity", async (route) => {
    const response = await route.fetch();
    const review = await response.json() as { pr: Record<string, unknown> } & Record<string, unknown>;
    await route.fulfill({ response, json: { ...review, pr: { ...review.pr, state: "closed", merged: true } } });
  });

  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await expect(page.locator(".pr-header-strip .review-status")).toHaveText("Merged");
  await expect(page.locator(".pr-header-meta")).toContainText("closed");
});

test("opens PR description references on GitHub in new tabs", async ({ page, context }) => {
  const sourceResponse = await page.request.post("/api/pr/open", { data: { input: prUrl } });
  const sourceReview = await sourceResponse.json() as { pr: Record<string, unknown> } & Record<string, unknown>;
  const linkedPrUrl = "https://github.com/example/stack/pull/190596";
  await page.getByRole("link", { name: "Home" }).click();
  await page.route("**/api/pr/open", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...sourceReview, pr: { ...sourceReview.pr, key: "github.com/example/stack#190596", url: linkedPrUrl, body: "Stack from ghstack (oldest at bottom):\n\n* #190594\n* [#190595](https://github.com/example/stack/pull/190595)\n* -> #190596" } }) });
  });
  await page.locator("input").first().fill(linkedPrUrl);
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".review-layout")).toBeVisible();
  await page.getByRole("button", { name: "Expand PR summary" }).click();

  for (const number of [190594, 190595]) {
    const url = `https://github.com/example/stack/pull/${number}`;
    await context.route(url, (route) => route.fulfill({ contentType: "text/html", body: `<title>PR ${number}</title>` }));
    const reference = page.getByRole("link", { name: `#${number}` });
    await expect(reference).toHaveAttribute("href", url);
    await expect(reference).toHaveAttribute("target", "_blank");
    const popupPromise = page.waitForEvent("popup");
    await reference.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(url);
    await popup.close();
  }
});

test("shows GPU workspace MVP constraints for unsupported repos", async ({ page }) => {
  await openTools(page);
  await page.getByRole("menuitem", { name: "GPU workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "GPU workspace" });
  await expect(dialog.getByText("1 GPU", { exact: true })).toBeVisible();
  await expect(dialog.getByText("no persistent disk", { exact: true })).toBeVisible();
  await expect(dialog.getByText("15m TTL", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open GPU workspace" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Ask workspace agent" })).toHaveCount(0);
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
  const side = page.locator(".side");
  await expect(side).toBeVisible();
  const resizeHandle = page.getByRole("separator", { name: "Resize side panel" });
  const resizeBox = await resizeHandle.boundingBox();
  if (resizeBox == null) throw new Error("Missing side panel resize handle");
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x - 600, resizeBox.y + 100);
  await page.mouse.up();
  expect(await side.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(720);
  await page.getByRole("button", { name: "Focus review panel" }).click();
  await expect(page.locator(".review-layout")).toHaveClass(/side-focused/);
  await expect(page.locator(".files")).toBeHidden();
  expect(await side.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(900);
  await page.keyboard.press("Escape");
  await expect(page.locator(".review-layout")).not.toHaveClass(/side-focused/);
  await expect(page.locator(".files")).toBeVisible();
  const emptyReviewSummary = page.locator(".review-summary-empty");
  await expect(emptyReviewSummary).toBeVisible();
  await emptyReviewSummary.getByRole("button", { name: "Start review" }).click();
  await expect(page.getByPlaceholder("Overall review body")).toBeVisible();

  await page.getByRole("button", { name: "Hide review panel" }).click();
  await expect(page.locator(".side")).toHaveCount(0);
  await toolbar.getByRole("button", { name: /Pi review/ }).click();
  await expect(page.locator(".side")).toBeVisible();
  await expect(page.getByRole("region", { name: "Pi terminal session" })).toBeVisible();

  await toolbar.locator(".file-navigator > summary").click();
  await expect(toolbar.locator(".file-navigator-list")).toBeVisible();
});

test("keeps collapsed files attached to the header beside a tall side panel", async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  const files = page.locator(".file");
  for (let index = 0; index < await files.count(); index += 1) {
    const file = files.nth(index);
    if (await file.locator(".diff-row").count() > 0) await file.locator(".file-summary-left").click();
  }
  await openSideTab(page, "Review");

  const geometry = await page.evaluate(() => {
    const header = document.querySelector(".pr-header-strip")!.getBoundingClientRect();
    const fileList = document.querySelector(".files")!.getBoundingClientRect();
    const side = document.querySelector(".side")!.getBoundingClientRect();
    return { contentGap: fileList.top - header.bottom, sideHeight: side.height };
  });
  expect(geometry.contentGap).toBeLessThanOrEqual(24);
  expect(geometry.sideHeight).toBeGreaterThan(800);
});

test("keeps the diff and files toolbar within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const toolbar = page.locator(".files-toolbar");
  await expect(toolbar).toBeVisible();
  expect(await toolbar.evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(toolbar.getByRole("button", { name: "Split view" })).toBeInViewport();
  await expect(toolbar.getByRole("button", { name: "Review changes" })).toBeInViewport();
  expect((await page.locator(".file").first().boundingBox())?.width).toBeLessThanOrEqual(359);
});

test("keeps compact Review actions separate on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSideTab(page, "Review");
  const actions = page.locator(".github-draft-review-actions button");
  const first = await actions.nth(0).boundingBox();
  const second = await actions.nth(1).boundingBox();
  if (first == null || second == null) throw new Error("Missing private GitHub review actions");
  expect(first.x).toBeGreaterThanOrEqual(0);
  expect(first.x + first.width).toBeLessThanOrEqual(390);
  expect(first.x + first.width).toBeLessThanOrEqual(second.x);

  await page.getByRole("button", { name: "Focus review panel" }).click();
  const focusedSide = await page.locator(".side").boundingBox();
  if (focusedSide == null) throw new Error("Missing focused mobile Review panel");
  expect(focusedSide.x + focusedSide.width).toBeLessThanOrEqual(382);
});

test("keeps tablet Review controls reachable through panel scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 });
  await openReviewForm(page);
  await page.getByPlaceholder("Overall review body").fill("tablet review");
  const reviewPanel = page.locator(".review-tab-panel");
  await page.getByRole("button", { name: "Submit review (0)" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Submit review (0)" })).toBeInViewport();
  expect(await reviewPanel.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  expect(await reviewPanel.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await reviewPanel.evaluate((element) => element.clientHeight));
});

test("caps focused Comments content on ultrawide screens", async ({ page }) => {
  await page.setViewportSize({ width: 4800, height: 1800 });
  await openSideTab(page, "Comments");
  await page.getByRole("button", { name: "Focus review panel" }).click();
  const comments = await page.locator(".comments-tab-panel > .panel").boundingBox();
  if (comments == null) throw new Error("Missing focused Comments panel");
  expect(comments.width).toBeLessThanOrEqual(1100);
  expect(comments.x).toBeGreaterThan(1500);
});

test("opens a line thread from the keyboard", async ({ page }) => {
  const row = (await openFileWithAddedRows(page, 1)).first();
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".inline-thread.local-thread")).toBeVisible();
  await expect(page.locator(".inline-thread.local-thread .pi-native-terminal.compact")).toBeVisible();
});

test("creates, edits, and removes draft comments", async ({ page }) => {
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = Number.parseInt(await row.getAttribute("data-line") ?? "", 10);
  if (path == null || !Number.isInteger(line)) throw new Error("Missing draft target");
  await loadDraftReviewFromTerminal(page, [{ id: "editable-draft", path, line, side: "RIGHT", body: "first draft" }]);
  await openSideTab(page, "Review");

  await expect(page.locator(".review-summary .draft-card").first()).toContainText("first draft");
  await page.getByLabel("Edit draft").first().click();
  await page.locator(".draft-card textarea").first().fill("edited draft");
  await expect(page.locator(".review-summary .draft-card").first()).toContainText("edited draft");

  await page.locator(".review-summary .draft-card").first().getByLabel("Remove draft").click();
  await expect(page.locator(".review-summary .draft-card")).toHaveCount(0);
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

test("shows private GitHub draft pull failures in the Review panel", async ({ page }) => {
  await page.route("**/api/github-draft-review/pull", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "GitHub unavailable" }) });
  });

  await openSideTab(page, "Review");
  await page.getByRole("button", { name: "Pull private GitHub comments" }).click();

  await expect(page.locator(".github-draft-review").getByRole("alert")).toContainText("GitHub draft failed: GitHub unavailable");
});

test("copies all draft comments with diff context", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = Number.parseInt(await row.getAttribute("data-line") ?? "", 10);
  if (path == null || !Number.isInteger(line)) throw new Error("Missing draft target");
  await loadDraftReviewFromTerminal(page, [{ id: "handoff-draft", path, line, side: "RIGHT", body: "send this to another agent" }]);
  await openSideTab(page, "Review");
  await page.getByRole("button", { name: "Copy draft context" }).click();

  await expect(page.getByRole("button", { name: "Copied context" })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("# PR review draft context");
  expect(text).toContain("send this to another agent");
  expect(text).toContain("Diff hunk context:\n```diff\n@@");
});

test("shows local draft save failures and retries them", async ({ page }) => {
  let saves = 0;
  await page.route("**/api/draft-review/save", async (route) => {
    saves += 1;
    if (saves === 1) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk full" }) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ draftReview: { prKey: openedPr!.key, headSha: openedPr!.headSha, event: "COMMENT", body: "keep this", comments: [], updatedAt: "now" } }) });
  });

  await openReviewForm(page);
  await page.getByPlaceholder("Overall review body").fill("keep this");
  await expect(page.locator(".draft-save-status.is-error")).toContainText("Draft not saved: disk full");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".draft-save-status.is-saved")).toContainText("Draft saved");
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
  const path = await rows.nth(3).getAttribute("data-path");
  if (path == null) throw new Error("Missing range path");
  await loadDraftReviewFromTerminal(page, [{ id: "range-draft", path, line: Number.parseInt(lastLine, 10), startLine: Number.parseInt(firstLine, 10), side: "RIGHT", body: "range draft" }]);

  await openSideTab(page, "Review");
  await expect(page.locator(".review-summary .draft-card", { hasText: "range draft" })).toContainText(`${firstLine}-${lastLine}`);
  await expect(page.getByRole("button", { name: /Submit review/ })).toBeEnabled();
});

test("keeps submit visible while many draft comments scroll", async ({ page }) => {
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = await row.getAttribute("data-line");
  if (openedPr == null || path == null || line == null) throw new Error("Missing draft review target");
  await page.request.post("/api/draft-review/save", { data: {
    prKey: openedPr.key,
    headSha: openedPr.headSha,
    event: "COMMENT",
    body: "",
    comments: Array.from({ length: 12 }, (_, index) => ({ id: `scroll-draft-${index}`, path, line: Number.parseInt(line, 10), side: "RIGHT", body: `Draft comment ${index + 1} with enough text to occupy space in the review panel.` })),
  } });

  await page.reload();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
  await openSideTab(page, "Review");

  await expect(page.getByRole("button", { name: "Submit review (12)" })).toBeInViewport();
  await expect(page.locator(".review-draft-list")).toHaveJSProperty("scrollTop", 0);
  expect(await page.locator(".review-draft-list").evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(true);
});

test("keeps draft cards compact in the focused Review panel", async ({ page }) => {
  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = await row.getAttribute("data-line");
  if (openedPr == null || path == null || line == null) throw new Error("Missing draft review target");
  await page.request.post("/api/draft-review/save", { data: {
    prKey: openedPr.key,
    headSha: openedPr.headSha,
    event: "COMMENT",
    body: "",
    comments: Array.from({ length: 4 }, (_, index) => ({ id: `compact-draft-${index}`, path, line: Number.parseInt(line, 10), side: "RIGHT", body: `Compact draft comment ${index + 1}.` })),
  } });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await page.reload();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
  await openSideTab(page, "Review");
  await page.getByRole("button", { name: "Focus review panel" }).click();

  const summaryBox = await page.locator(".review-summary").boundingBox();
  const cardHeights = await page.locator(".review-draft-list .draft-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
  if (summaryBox == null) throw new Error("Missing focused Review panel");
  expect(summaryBox.width).toBeLessThanOrEqual(1100);
  expect(Math.max(...cardHeights)).toBeLessThan(100);
  await expect(page.getByRole("button", { name: "Submit review (4)" })).toBeInViewport();
});

test("keeps review submission reachable on a short mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 480 });
  await openReviewForm(page);
  await page.getByPlaceholder("Overall review body").fill("mobile review");

  await expect(page.getByRole("button", { name: "Submit review (0)" })).toBeInViewport();
  const sideBox = await page.locator(".side").boundingBox();
  expect(sideBox?.y).toBeLessThanOrEqual(8);
  expect((sideBox?.y ?? 0) + (sideBox?.height ?? 0)).toBeLessThanOrEqual(480);
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

  const row = (await openFileWithAddedRows(page, 1)).first();
  const path = await row.getAttribute("data-path");
  const line = Number.parseInt(await row.getAttribute("data-line") ?? "", 10);
  if (path == null || !Number.isInteger(line)) throw new Error("Missing draft target");
  await loadDraftReviewFromTerminal(page, [{ id: "abc", path, line, side: "RIGHT", body: "stale line draft" }]);
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
  const editor = firstThread.locator(".github-comment-edit");
  await expect(editor.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(firstThread.locator(".github-comment-header").getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await editor.getByLabel("Edit comment").fill("edited from pi-review");
  await editor.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => editPayload).toMatchObject({ body: "edited from pi-review" });
  await expect(firstThread.locator(".markdown").first()).toContainText("edited from pi-review");
});

test("keeps failed GitHub comment edits and replies retryable", async ({ page }) => {
  await page.route("**/api/comment/edit", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "edit rejected" }) });
  });
  await page.route("**/api/comment/reply", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "reply rejected" }) });
  });

  await openSideTab(page, "Comments");
  const firstThread = page.locator(".side .github-thread").first();
  await firstThread.getByRole("button", { name: "Edit" }).first().click();
  await firstThread.getByLabel("Edit comment").fill("preserve this edit");
  await firstThread.getByRole("button", { name: "Save" }).click();
  await expect(firstThread.getByRole("alert")).toContainText("Edit failed: edit rejected");
  await expect(firstThread.getByLabel("Edit comment")).toHaveValue("preserve this edit");
  await expect(firstThread.getByRole("button", { name: "Retry" })).toBeVisible();

  const replyThread = page.locator(".side .github-thread", { has: page.getByLabel("Reply to thread") }).first();
  await replyThread.getByLabel("Reply to thread").fill("preserve this reply");
  await replyThread.getByRole("button", { name: "Reply" }).click();
  await expect(replyThread.locator(".thread-reply").getByRole("alert")).toContainText("Reply failed: reply rejected");
  await expect(replyThread.getByLabel("Reply to thread")).toHaveValue("preserve this reply");
  await expect(replyThread.locator(".thread-reply").getByRole("button", { name: "Retry" })).toBeVisible();
});

test("collapses and focuses existing comment threads", async ({ page }) => {
  await openSideTab(page, "Comments");
  const thread = page.locator(".side .github-thread").first();
  await expect(thread.locator(".markdown").first()).toBeVisible();
  await thread.getByLabel("Collapse thread").click();
  await expect(thread.locator(".markdown")).toHaveCount(0);
  await expect(thread.getByLabel("Expand thread")).toBeVisible();
  await thread.getByRole("button", { name: /Conversation thread|Review summary|Review thread/ }).click();
  await expect(thread.locator(".markdown").first()).toBeVisible();
});

test("collapses all review threads from the files toolbar", async ({ page }) => {
  await page.getByRole("button", { name: "Collapse review threads" }).click();
  await expect(page.getByRole("button", { name: "Expand review threads" })).toBeVisible();

  await openSideTab(page, "Comments");
  const thread = page.locator(".side .github-thread").first();
  await expect(thread).toHaveClass(/minimized/);

  await page.getByRole("button", { name: "Expand review threads" }).click();
  await expect(thread).not.toHaveClass(/minimized/);
});

test("switches and persists Primer-backed GitHub themes", async ({ page }) => {
  const theme = page.getByLabel("Theme");
  const provider = page.locator('[data-component="ThemeProvider"]');

  await theme.selectOption("github-light");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("github-light");
  await expect(provider).toHaveAttribute("data-color-mode", "light");

  await theme.selectOption("github-dimmed");
  await expect(provider).toHaveAttribute("data-color-mode", "dark");
  await expect(provider).toHaveAttribute("data-dark-theme", "dark_dimmed");

  await theme.selectOption("github-dark");
  await expect(provider).toHaveAttribute("data-dark-theme", "dark");
  await page.reload();
  await expect(page.getByLabel("Theme")).toHaveValue("github-dark");
});

test("supports keyboard navigation across review tabs", async ({ page }) => {
  await openSideTab(page, "Review");
  const reviewTab = page.getByRole("tab", { name: /^Review/ });
  await reviewTab.focus();
  await page.keyboard.press("ArrowRight");

  await expect(page.getByRole("tab", { name: /^Pi/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pi-terminal-session")).toBeVisible();
});

test("opens and dismisses the Tools menu from the keyboard", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /Tools/ });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Code walk" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Code walk" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("keeps the native Pi terminal usable on a short mobile viewport", async ({ page }) => {
  await mockNativeTerminal(page);
  await page.setViewportSize({ width: 375, height: 480 });
  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: "Focus terminal" }).click();

  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeInViewport();
  await expect(page.locator(".xterm-rows")).toContainText("Native Pi ready");
});

test("opens the native Pi terminal by default and focuses it on demand", async ({ page }) => {
  const terminalMessages = await mockNativeTerminal(page);
  await openSideTab(page, "Pi");

  await expect(page.locator(".review-layout")).not.toHaveClass(/side-focused/);
  await page.locator(".pi-terminal-session").getByRole("button", { name: "Focus terminal" }).click();
  await expect(page.locator(".review-layout")).toHaveClass(/side-focused/);
  await expect(page.getByRole("region", { name: "Pi terminal session" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await expect(page.locator(".xterm-rows")).toContainText("Native Pi ready");
  await page.keyboard.type("x");
  await expect.poll(async () => (await terminalMessages()).some((message) => message.includes('"type":"input"') && message.includes('"data":"x"'))).toBe(true);
  await expect.poll(async () => (await terminalMessages()).some((message) => message.includes('"type":"resize"'))).toBe(true);
});

test("opens a line thread as an inline native Pi terminal by default", async ({ page }) => {
  await mockNativeTerminal(page);
  const rows = await openFileWithAddedRows(page, 1);
  await rows.first().click();
  const thread = page.locator(".local-thread");
  await expect(thread).toHaveClass(/terminal-open/);
  await expect(thread.locator(".pi-native-terminal.compact")).toBeVisible();
  await expect(thread.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await expect(thread.locator(".xterm-rows")).toContainText("Native Pi ready");

  await thread.getByRole("button", { name: "Add comment" }).click();
  await thread.getByRole("textbox", { name: "Review comment" }).fill("Human-authored review draft.");
  await thread.getByRole("button", { name: "Add draft comment" }).click();
  await expect(page.locator(".inline-thread.draft", { hasText: "Human-authored review draft." })).toBeVisible();
  await expect(thread.locator(".pi-native-terminal.compact")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(thread).toBeVisible();

  await page.locator(".pr-header-strip").click();
  const marker = page.getByRole("button", { name: /Pi terminal ·/ });
  await expect(thread).toHaveCount(0);
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(thread.locator(".pi-native-terminal.compact")).toBeVisible();

  await expect(thread.getByRole("button", { name: "Use chat" })).toHaveCount(0);
  await expect(thread.getByPlaceholder("Write a draft comment or ask Pi about this line")).toHaveCount(0);

  const path = await rows.first().getAttribute("data-path");
  const line = Number.parseInt(await rows.first().getAttribute("data-line") ?? "", 10);
  if (path == null || !Number.isInteger(line) || openedPr == null) throw new Error("Missing terminal draft target");
  const body = "Terminal-created review draft.";
  await emitNativeTerminalMessage(page, { type: "draftReview", draftReview: { prKey: openedPr.key, headSha: openedPr.headSha, event: "COMMENT", body: "", comments: [{ id: "terminal-draft", path, line, side: "RIGHT", body }], updatedAt: "now" } });
  await openSideTab(page, "Review");
  await expect(page.locator(".review-summary .draft-card", { hasText: body })).toBeVisible();
});

test("describes shared dialogs for assistive technology", async ({ page }) => {
  await openTools(page);
  await page.getByRole("menuitem", { name: "Session settings" }).click();
  const dialog = page.getByRole("dialog");
  const descriptionId = await dialog.getAttribute("aria-describedby");
  if (descriptionId == null) throw new Error("Missing dialog description");
  await expect(page.locator(`#${descriptionId}`)).toContainText("Pi settings dialog");
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

test("selects diff code text without opening a thread", async ({ page }) => {
  await openFirstFile(page);
  const code = page.locator(".file").first().locator(".diff-row.added code").first();
  await expect(code).toBeVisible();
  const box = await code.boundingBox();
  if (box == null) throw new Error("Diff code has no bounding box");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(Math.min(box.x + box.width - 4, box.x + 160), y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toEqual("");
  await expect(page.locator(".local-thread")).toHaveCount(0);
});

test("runs a separate focus areas review and opens native focus terminals", async ({ page }) => {
  await mockNativeTerminal(page);
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
  const collapsedFocusArea = page.locator(".focus-area-collapsed");
  await expect(collapsedFocusArea).toBeVisible();
  await collapsedFocusArea.focus();
  await page.keyboard.press("Enter");
  await expect(focusArea.locator(".pi-native-terminal.compact")).toBeVisible();
  await expect(focusArea.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await expect(focusArea.getByRole("button", { name: "Use chat" })).toHaveCount(0);
  await expect(focusArea.getByPlaceholder("Write a draft comment or ask Pi about this focus area")).toHaveCount(0);

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

test("keeps a clean focus scan compact when the Pi panel is focused", async ({ page }) => {
  await page.route(/\/api\/pi\/focus-review\/status$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { status: "complete", answer: "No focus areas found. All good." } }) });
  });
  await page.route(/\/api\/pi\/focus-review$/, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ job: { id: "clean-focus-job" } }) });
  });

  await page.setViewportSize({ width: 1600, height: 1200 });
  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: "Focus review panel" }).click();
  await page.getByRole("button", { name: "Focus scan" }).click();

  const panel = page.locator(".ai-review");
  await expect(panel).toContainText("Focus scan clean");
  await expect(page.locator(".focus-area-inline")).toHaveCount(0);
  const actionBox = await panel.locator(".pi-actions").boundingBox();
  const terminalBox = await panel.locator(".pi-terminal-session").boundingBox();
  const actionButtons = panel.locator(".pi-action > button");
  await expect(actionButtons).toHaveCount(2);
  const buttonBoxes = await actionButtons.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
  if (actionBox == null || terminalBox == null) throw new Error("Missing compact Pi layout");
  expect(actionBox.height).toBeLessThan(80);
  expect(Math.max(...buttonBoxes)).toBeLessThan(40);
  expect(terminalBox.height).toBeGreaterThan(500);
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

test("runs the right-sidebar Pi review beside the native terminal", async ({ page }) => {
  await mockNativeTerminal(page);
  await page.setViewportSize({ width: 2000, height: 1000 });
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

  await openSideTab(page, "Pi");
  await page.getByRole("button", { name: /Full review|Refresh findings/ }).click();

  const panel = page.locator(".ai-review");
  await expect(panel).toContainText("Correctness:");
  const findingsBox = await panel.locator(".pi-review-findings").boundingBox();
  const terminalBox = await panel.locator(".pi-terminal-session").boundingBox();
  if (findingsBox == null || terminalBox == null) throw new Error("Missing Pi review layout");
  expect(findingsBox.y + findingsBox.height).toBeLessThanOrEqual(terminalBox.y + 1);
  await Promise.all([
    page.waitForRequest(/\/api\/file\/open$/),
    panel.getByRole("link", { name: "csrc/flash_attn/src/flash_fwd_kernel.h:1276" }).click(),
  ]);
  expect(openedFile).toMatchObject({ path: "csrc/flash_attn/src/flash_fwd_kernel.h", line: 1276 });
  reviewAnswer = "- **Tests:** rerun the CUDA smoke test.";
  await panel.getByRole("button", { name: "Refresh findings" }).click();
  await expect(panel.getByText("CUDA smoke test")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Use chat" })).toHaveCount(0);
  await expect(panel.getByPlaceholder("Message Pi…")).toHaveCount(0);

  await panel.getByRole("button", { name: "Focus terminal" }).click();
  await expect(panel).toHaveClass(/terminal-focused/);
  await expect(panel.locator(".pi-actions")).toBeHidden();
  await expect(panel.locator(".pi-review-findings")).toBeHidden();
  const focusedSide = await page.locator(".side").boundingBox();
  const focusedTerminal = await panel.locator(".pi-terminal-session").boundingBox();
  if (focusedSide == null || focusedTerminal == null) throw new Error("Missing focused Pi terminal layout");
  expect(focusedTerminal.width).toBeGreaterThan(focusedSide.width * 0.95);
  await expect(panel.getByRole("textbox", { name: "Terminal input" })).toBeInViewport();

  await panel.getByRole("button", { name: "Show review context" }).click();
  await expect(panel).not.toHaveClass(/terminal-focused/);
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
  await loadDraftReviewFromTerminal(page, [{ id: "feedback-draft", path, line: lineNumber, side: "RIGHT", body: "Keep this local feedback out of GitHub." }]);
  await openSideTab(page, "Review");
  await expect(page.locator(".review-summary .draft-card", { hasText: "Keep this local feedback out of GitHub." })).toBeVisible();

  await openSideTab(page, "Pi");
  const panel = page.locator(".ai-review");
  await panel.getByRole("button", { name: /Full review|Refresh findings/ }).click();
  await expect(panel).toContainText("Global feedback from Pi");
  await panel.getByRole("button", { name: /Focus scan|Refresh focus scan/ }).click();
  await expect(panel).toContainText("copied focus area");
  await openSideTab(page, "Review");
  const reviewPanel = page.locator(".side .panel");
  const finalDraftSave = page.waitForResponse((response) => response.url().endsWith("/api/draft-review/save") && (response.request().postDataJSON() as { body?: string }).body === "Keep this overall note local too.");
  await reviewPanel.getByPlaceholder("Overall review body").fill("Keep this overall note local too.");
  await finalDraftSave;
  await reviewPanel.getByRole("button", { name: "Copy feedback prompt" }).click();

  await expect(reviewPanel.getByRole("button", { name: "Copied feedback prompt" })).toBeVisible();
  await expect(reviewPanel.locator(".draft-card", { hasText: "Keep this local feedback out of GitHub." })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("COPIED REVIEW FEEDBACK PROMPT");
  await expect.poll(() => feedbackPayload?.mode).toBe("review-feedback");
  const userComments = feedbackPayload?.userComments as Array<{ body?: string }> | undefined;
  const aiComments = feedbackPayload?.aiComments as Array<{ role?: string; text?: string }> | undefined;
  const focusAreas = feedbackPayload?.focusAreas as Array<{ path?: string; startLine?: number; title?: string }> | undefined;
  expect(userComments?.some((comment) => comment.body === "Keep this overall note local too.")).toBe(true);
  expect(userComments?.some((comment) => comment.body === "Keep this local feedback out of GitHub.")).toBe(true);
  expect(userComments?.some((comment) => comment.body?.includes("Before #2448"))).toBe(true);
  expect(aiComments).toEqual([]);
  expect(focusAreas?.[0]).toMatchObject({ path, startLine: lineNumber, title: "copied focus area" });
  expect(feedbackPayload?.globalFeedback).toBe("Global feedback from Pi.");

  await page.reload();
  await expect(page.locator(".review-layout")).toBeVisible({ timeout: 60_000 });
  await openSideTab(page, "Review");
  await expect(page.locator(".side .draft-card", { hasText: "Keep this local feedback out of GitHub." })).toBeVisible();
  await expect(page.getByPlaceholder("Overall review body")).toHaveValue("Keep this overall note local too.");
});
