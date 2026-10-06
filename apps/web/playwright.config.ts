import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
// The monkey test drives the simulator against its own feed service (free script
// transcriber, fuzzy extractor: no API calls) and reads both servers' logs.
const LIVE = /(monkey|stop|review)\.spec/;
const FEED_PORT = Number(process.env.E2E_FEED_PORT ?? 8797);
export const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".e2e-logs");
mkdirSync(LOG_DIR, { recursive: true });
// Chrome loops this file as the microphone: 1 s of 16 kHz silence (a 44-byte WAV header, then zeros).
const SILENCE = path.join(LOG_DIR, "silence.wav");
const wav = Buffer.alloc(44 + 32_000);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + 32_000, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16_000, 24);
wav.writeUInt32LE(32_000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(32_000, 40);
writeFileSync(SILENCE, wav);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The 1 CI retry is for DETECTION, not tolerance: a test that only passes on
  // retry is flaky. Quarantine it and fix it.
  retries: process.env.CI ? 1 : 0,
  // A cold Next.js dev server compiles each route on first hit; fewer workers keep CI from timing out on it.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: LIVE },
    {
      // Specs that stream to the feed service through the simulator, with a silent fake mic.
      name: "live",
      testMatch: LIVE,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${SILENCE}`] },
      },
    },
  ],
  webServer: [
    {
      command: `npx next dev -p ${PORT} 2>&1 | tee ${path.join(LOG_DIR, "web.log")}`,
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WEBHOOK_URL: `${BASE_URL}/api/mock-webhook`, ENABLE_DEV_ROUTES: "true", INGEST_URL: `ws://127.0.0.1:${FEED_PORT}` },
    },
    {
      command: `pnpm --silent --filter @serv/pipeline cli feed serve --transcriber script --extractor fuzzy 2>&1 | tee ${path.join(LOG_DIR, "feed.log")}`,
      port: FEED_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WEBHOOK_URL: `${BASE_URL}/api/mock-webhook`, ENABLE_DEV_ROUTES: "true", INGEST_PORT: String(FEED_PORT) },
    },
  ],
});
