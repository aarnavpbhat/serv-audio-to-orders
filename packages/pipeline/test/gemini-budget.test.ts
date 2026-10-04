import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GeminiBudgetError, GeminiClient, isDailyQuota } from "../src/extract/gemini";

const ledgerIn = (dir: string) => path.join(dir, "gemini-ledger.json");
/** The client keeps one ledger per model, since Google's quotas are per model. */
const modelLedger = (dir: string) => path.join(dir, "gemini-ledger.gemini-flash-latest.json");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

describe("Gemini daily budget", () => {
  it("refuses to send once the cap is reached, without touching the network", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gemini-budget-"));
    const client = new GeminiClient("not-a-real-key", "gemini-flash-latest", 600, null, { cap: 0, file: ledgerIn(dir) });
    await expect(client.json({ system: "s", user: "u" })).rejects.toBeInstanceOf(GeminiBudgetError);
  });

  it("refuses for the rest of the day after Google reports the daily quota is used up", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gemini-budget-"));
    writeFileSync(modelLedger(dir), JSON.stringify({ day: today(), requests: 3, exhausted: true, tier: "free" }));
    const client = new GeminiClient("not-a-real-key", "gemini-flash-latest", 600, null, { cap: 100, file: ledgerIn(dir) });
    await expect(client.json({ system: "s", user: "u" })).rejects.toThrow(/used up/);
    expect(JSON.parse(readFileSync(modelLedger(dir), "utf8")).requests).toBe(3);
  });

  it("starts a fresh count on a new Pacific day", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gemini-budget-"));
    writeFileSync(modelLedger(dir), JSON.stringify({ day: "2000-01-01", requests: 999, exhausted: true, tier: "free" }));
    const client = new GeminiClient("not-a-real-key", "gemini-flash-latest", 600, null, { cap: 100, file: ledgerIn(dir) });
    expect(client.ledger()).toMatchObject({ day: today(), requests: 0, exhausted: false, tier: "free" });
  });
});

describe("isDailyQuota", () => {
  const quotaError = (quotaId: string) =>
    Object.assign(new Error(JSON.stringify({ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId }] }] } })), { status: 429 });

  it("treats a per-day quota violation as daily", () => {
    expect(isDailyQuota(quotaError("GenerateRequestsPerDayPerProjectPerModel-FreeTier"))).toBe(true);
  });

  it("treats a per-minute violation as retryable, even though the message mentions billing", () => {
    expect(isDailyQuota(quotaError("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"))).toBe(false);
  });
});
