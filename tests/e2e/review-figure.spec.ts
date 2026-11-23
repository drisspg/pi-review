import { expect, test } from "@playwright/test";
import { REVIEW_PAIR_VERSION } from "../../src/analysis-types";
import type { OpenResponse } from "../../web/src/types";

const diagram = "```schematic\n" + JSON.stringify({
  title: "Worker assignments", direction: "down",
  nodes: [
    { id: "w0", label: "Worker 0" }, { id: "w1", label: "Worker 1" },
    { id: "first", label: "Rows [0, 8)" }, { id: "tail", label: "Rows [8, 11)" },
  ],
  edges: [{ from: "w0", to: "first", label: "writes" }, { from: "w1", to: "tail", label: "writes" }],
}) + "\n```";
const body = `The second worker stops at row 11.\n\n${diagram}\n\n### Evidence\nThe input has eleven rows.`;
const url = "https://github.com/example/tiles/pull/1";
const record = { prKey: "github.com/example/tiles#1", headSha: "head", createdAt: "2025-01-01", updatedAt: "2025-01-01", provenance: { reviewPairId: "pair", runId: "run", version: REVIEW_PAIR_VERSION, model: "fixture", thinkingLevel: "medium" } };
const focusScan = { ...record, id: "focus", answer: `### tiles.py:1 — Check the tail\n${body}`, areaStates: {} };
const paired = "```schematic\n" + JSON.stringify({
  title: "Paired helper: requested rows [64, 128), 16 rows per block", direction: "down",
  nodes: [{ id: "base", label: "Base row assignment" }, { id: "pr", label: "PR: warpdrive row assignment" }, { id: "fwd", label: "Forward state" }, { id: "rev", label: "Reverse state" }],
  edges: [{ from: "base", to: "fwd", label: "4 blocks · rows [0, 64)" }, { from: "base", to: "rev", label: "4 blocks · rows [0, 64)" }, { from: "pr", to: "fwd", label: "all 8 blocks" }, { from: "pr", to: "rev", label: "0 blocks" }],
}) + "\n```";
const aiReview = { ...record, id: "general", answer: `Review the output bounds.\n\n${paired}` };
const review: OpenResponse = {
  pr: { key: record.prKey, headSha: record.headSha, url, title: "Bound worker writes", body: null, state: "OPEN", author: "example", baseSha: "base", filesChanged: 1, existingCommentCount: 0, lastOpenedAt: record.createdAt, lastReviewedHeadSha: null, lastReviewEvent: null, reviewDecision: null },
  files: [{ filename: "tiles.py", status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+end = min(begin + 8, rows)" }],
  comments: [], issueComments: [], reviewSummaries: [], fileReviews: [], draftReview: null,
  focusScan, focusScans: [focusScan], aiReview, aiReviews: [aiReview], guideReview: null, overview: null,
};

test("draws worker-to-range assignments in both focus views and the verdict, and copies the original diagram", async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.routeWebSocket("**/api/pi/terminal*", () => {});
  await page.route("**/api/pr/stack", route => route.fulfill({ json: { stack: null } }));
  await page.route("**/api/pr/checks", route => route.fulfill({ json: { checks: { total: 0, success: 0, failure: 0, pending: 0, neutral: 0, failures: [] } } }));
  await page.route("**/api/pr/open", route => route.fulfill({ json: review }));
  await page.goto(`/#/review?pr=${encodeURIComponent(url)}`);
  await page.getByRole("button", { name: /^Pi review/ }).click();
  const findings = page.getByRole("list", { name: "Focus findings" });
  await findings.getByRole("button", { name: "View diff: Check the tail" }).click();
  for (const view of [page.locator(".focus-area-inline"), findings]) {
    const figure = view.getByRole("figure", { name: "Worker assignments" });
    await expect(figure.locator(".react-flow:not(.schematic-measuring)")).toBeVisible();
    for (const label of ["Worker 0", "Worker 1", "Rows [0, 8)", "Rows [8, 11)"]) await expect(figure.getByText(label, { exact: true })).toBeVisible();
    await expect(figure.locator(".react-flow__edge-path[marker-end]")).toHaveCount(2);
    await expect(figure.getByText("writes", { exact: true }).filter({ visible: true })).toHaveCount(2);
  }
  const verdict = page.locator(".general-review").getByRole("figure");
  await expect(verdict.locator(".react-flow__edge-path[marker-end]")).toHaveCount(4);
  const legend = verdict.getByRole("list", { name: "Connections" });
  await expect(legend.getByRole("listitem")).toHaveText([
    "Base row assignment → Forward state4 blocks · rows [0, 64)", "Base row assignment → Reverse state4 blocks · rows [0, 64)",
    "PR: warpdrive row assignment → Forward stateall 8 blocks", "PR: warpdrive row assignment → Reverse state0 blocks",
  ]);
  await expect(verdict.locator(".react-flow__edge-text").first()).toBeHidden();
  await verdict.screenshot({ path: testInfo.outputPath("paired-helper.png") });
  const finding = page.locator(".focus-area-inline .focus-area-finding");
  expect(await finding.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
  await page.locator(".focus-area-inline figure").screenshot({ path: testInfo.outputPath("worker-assignments.png") });
  await page.getByRole("button", { name: "Copy feedback prompt" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(body);
});
