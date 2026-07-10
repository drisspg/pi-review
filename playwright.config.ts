import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const port = Number.parseInt(process.env.PI_REVIEW_TEST_PORT ?? process.env.PI_PR_REVIEW_PORT ?? "43134", 10);
const fast = process.env.PI_REVIEW_FAST_TESTS === "1";
const statePath = resolve("test-results", `e2e-state-${port}.json`);
const stateEnv = `PI_REVIEW_STATE_PATH=${JSON.stringify(statePath)}`;
const command = fast
  ? `rm -f ${JSON.stringify(statePath)} && ${stateEnv} PI_PR_REVIEW_PORT=${port} npx tsx src/server.ts`
  : `rm -f ${JSON.stringify(statePath)} && ${stateEnv} PI_PR_REVIEW_PORT=${port} npm start`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: fast ? 30_000 : 90_000,
  expect: { timeout: 10_000 },
  workers: fast ? 3 : 1,
  fullyParallel: fast,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: fast ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: fast ? "off" : "retain-on-failure",
  },
  webServer: {
    command,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: fast,
    timeout: 30_000,
  },
});
