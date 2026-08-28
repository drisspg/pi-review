import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// Untracked local wrapper: Chromium child-process spawning is blocked in this
// shell context (Mach bootstrap_check_in denied), so run single-process.
export default defineConfig({
  ...config,
  use: {
    ...config.use,
    launchOptions: { args: ["--single-process", "--no-sandbox"] },
  },
});
