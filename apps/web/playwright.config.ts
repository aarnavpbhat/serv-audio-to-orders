import { defineConfig, devices } from "@playwright/test";

// @pattern testing/playwright.config
// @version 1.0.0
//
// Gone standard Playwright config (gone-standards patterns/testing), adapted:
// the app needs no Firebase or backend stubs. The golden path runs the real
// pipeline on fixture audio with the free ground-truth transcriber and the
// keyword extractor, so it spends no Deepgram or Gemini quota, and the webhook
// goes to this server's own mock receiver.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The 1 CI retry is for DETECTION, not tolerance: a test that only passes on
  // retry is flaky. Quarantine it and fix it.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { WEBHOOK_URL: `${BASE_URL}/api/mock-webhook` },
  },
});
