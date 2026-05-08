import { defineConfig } from "@playwright/test";

const port = Number.parseInt(process.env.PI_REVIEW_TEST_PORT ?? process.env.PI_PR_REVIEW_PORT ?? "43134", 10);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `PI_PR_REVIEW_PORT=${port} npm start`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
