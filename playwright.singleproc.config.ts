import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// Local wrapper for shells where Chromium child-process spawning is blocked
// (Mach bootstrap_check_in denied): run the browser single-process, one test
// per invocation. See AGENTS.md "Validation expectations".
export default defineConfig({
  ...config,
  use: {
    ...config.use,
    launchOptions: { args: ["--single-process", "--no-sandbox"] },
  },
});
