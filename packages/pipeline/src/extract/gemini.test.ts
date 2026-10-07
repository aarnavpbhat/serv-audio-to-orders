import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GenerateContentResponse } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { GeminiBudgetError, GeminiClient, GeminiSafetyBlockedError, SAFETY_SETTINGS, checkSafetyBlock, isDailyQuota } from "./gemini";

const ledgerIn = (dir: string) => path.join(dir, "gemini-ledger.json");
/** The client keeps one ledger per model, since Google's quotas are per model. */
const modelLedger = (dir: string) => path.join(dir, "gemini-ledger.gemini-flash-latest.json");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

describe("Gemini daily budget", () => {
  it("refuses to send once the cap is reached, without touching the network", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gemini-budget-"));
    const client = new GeminiClient("not-a-real-key", "gemini-flash-latest", 600, null, { cap: 0, file: ledgerIn(dir) });
    await expect(client.json({ site: "test", system: "s", user: "u" })).rejects.toBeInstanceOf(GeminiBudgetError);
  });

  it("refuses for the rest of the day after Google reports the daily quota is used up", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gemini-budget-"));
    writeFileSync(modelLedger(dir), JSON.stringify({ day: today(), requests: 3, exhausted: true, tier: "free" }));
    const client = new GeminiClient("not-a-real-key", "gemini-flash-latest", 600, null, { cap: 100, file: ledgerIn(dir) });
    await expect(client.json({ site: "test", system: "s", user: "u" })).rejects.toThrow(/used up/);
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

describe("Gemini safety", () => {
  const response = (r: object) => r as GenerateContentResponse;

  it("pins all four harm categories at BLOCK_ONLY_HIGH", () => {
    expect(SAFETY_SETTINGS.map((s) => s.category).sort()).toEqual([
      "HARM_CATEGORY_DANGEROUS_CONTENT",
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    ]);
    expect(new Set(SAFETY_SETTINGS.map((s) => s.threshold))).toEqual(new Set(["BLOCK_ONLY_HIGH"]));
  });

  it("passes a clean response", () => {
    expect(() => checkSafetyBlock(response({ candidates: [{ finishReason: "STOP" }] }), "extract")).not.toThrow();
  });

  it("throws a typed error and logs one line for prompt-level and candidate-level blocks", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => checkSafetyBlock(response({ promptFeedback: { blockReason: "SAFETY" } }), "extract")).toThrow(GeminiSafetyBlockedError);
    expect(() => checkSafetyBlock(response({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }), "extract")).toThrow(GeminiSafetyBlockedError);
    expect(write).toHaveBeenCalledTimes(2);
    expect(String(write.mock.calls[0]?.[0])).toContain("gemini_safety_block");
  });
});
