import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GoogleGenAI, type ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { FuzzyMatcher } from "../menu/fuzzy";
import { errorStatus, isTransient, sleep, withRetry } from "../lib/retry";
import type { Utterance } from "../schemas";
import type { BoundaryJudge } from "../segment/segment";
import type { RoleJudge } from "../transcribe/types";
import { FuzzyExtractor } from "./fuzzy-extractor";
import { LlmExtraction, extractionJsonSchema } from "./llm-schema";
import { BOUNDARY_PROMPT, PROMPT_VERSION, ROLE_PROMPT, SYSTEM_PROMPT, buildUserPrompt, formatUtterances, repairPrompt } from "./prompt";
import { addUsage, emptyUsage, type ExtractInput, type ExtractResult, type Extractor, type LlmUsage } from "./types";
import { validateEvents } from "./validate";

interface CallResult {
  text: string;
  usage: LlmUsage;
}

/** Thrown instead of calling Gemini once the free-tier budget is spent. Callers fall back to non-LLM paths. */
export class GeminiBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiBudgetError";
  }
}

export interface DailyBudget {
  /** Max requests sent per Pacific-time day (Gemini quotas reset at midnight PT). */
  cap: number;
  /** JSON ledger file shared by the CLI and the web app. */
  file: string;
}

interface Ledger {
  day: string;
  requests: number;
  /** Set when Google reports the daily quota is used up. */
  exhausted: boolean;
  /** "free" once a quota error names the free tier. */
  tier: "free" | "unknown";
  /** Full text of the most recent 429, for diagnosing which quota was hit. */
  last_429?: string;
}

const pacificDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

function readLedger(file: string): Ledger {
  const day = pacificDay();
  try {
    const l = JSON.parse(readFileSync(file, "utf8")) as Ledger;
    if (l.day === day) return l;
    return { day, requests: 0, exhausted: false, tier: l.tier ?? "unknown" };
  } catch {
    return { day, requests: 0, exhausted: false, tier: "unknown" };
  }
}

function writeLedger(file: string, l: Ledger): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(l, null, 2));
}

/** quotaId values from a 429's QuotaFailure details, e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier". */
function quotaIds(err: unknown): string[] {
  return [...String((err as Error)?.message ?? "").matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** A daily (not per-minute) quota error: waiting a minute will not help, so stop instead of retrying. */
export function isDailyQuota(err: unknown): boolean {
  return errorStatus(err) === 429 && quotaIds(err).some((id) => /PerDay/i.test(id));
}

export class GeminiClient {
  private readonly ai: GoogleGenAI;
  private nextSlot = 0;
  /** Running totals across every call made by this client. */
  readonly totals: LlmUsage;
  resolvedModel: string | null = null;

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly rpm: number,
    private readonly cacheDir: string | null,
    private budget: DailyBudget | null = null,
    private readonly thinking: "minimal" | "low" | "medium" | "high" = "low",
  ) {
    this.ai = new GoogleGenAI({ apiKey });
    this.totals = emptyUsage(model);
    // Google's free-tier quotas are per model, so each model gets its own ledger.
    if (budget) this.budget = { ...budget, file: budget.file.replace(/\.json$/, `.${model.replace(/[^a-z0-9.-]/gi, "_")}.json`) };
  }

  /** Today's request count and tier, for logs and the UI. */
  ledger(): Ledger | null {
    return this.budget ? readLedger(this.budget.file) : null;
  }

  /** Counts a request against the daily cap before it is sent; throws once the cap is reached. */
  private spend(): void {
    if (!this.budget) return;
    const l = readLedger(this.budget.file);
    if (l.exhausted) throw new GeminiBudgetError(`Gemini daily free-tier quota is used up for ${l.day} (Pacific). Resets at midnight PT.`);
    if (l.requests >= this.budget.cap) throw new GeminiBudgetError(`GEMINI_DAILY_CAP of ${this.budget.cap} requests reached for ${l.day} (Pacific).`);
    writeLedger(this.budget.file, { ...l, requests: l.requests + 1 });
  }

  /** Records what a 429 says about the tier and whether the day's quota is gone. */
  private noteQuota(err: unknown): void {
    if (!this.budget || errorStatus(err) !== 429) return;
    const msg = String((err as Error)?.message ?? "");
    const l = readLedger(this.budget.file);
    const free = quotaIds(err).some((id) => /FreeTier/i.test(id)) || /free_tier/i.test(msg);
    writeLedger(this.budget.file, { ...l, tier: free ? "free" : l.tier, exhausted: l.exhausted || isDailyQuota(err), last_429: msg.slice(0, 4000) });
  }

  private async throttle(): Promise<void> {
    const gap = 60_000 / Math.max(1, this.rpm);
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + gap;
    if (wait > 0) await sleep(wait);
  }

  async json(opts: { system: string; user: string; schema?: Record<string, unknown>; history?: { role: "user" | "model"; text: string }[] }): Promise<CallResult> {
    const contents = [...(opts.history ?? []), { role: "user" as const, text: opts.user }].map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
    const key = createHash("sha256")
      .update(JSON.stringify({ m: this.model, t: this.thinking, s: opts.system, c: contents, j: opts.schema ?? null }))
      .digest("hex")
      .slice(0, 24);
    const file = this.cacheDir ? path.join(this.cacheDir, `${key}.json`) : null;
    if (file && existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, "utf8")) as { text: string; model: string };
      const usage = { ...emptyUsage(hit.model), cached_calls: 1 };
      Object.assign(this.totals, addUsage(this.totals, usage));
      return { text: hit.text, usage };
    }

    const res = await withRetry(
      async () => {
        await this.throttle();
        this.spend();
        return this.ai.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: opts.system,
            temperature: 0,
            thinkingConfig: { thinkingLevel: this.thinking.toUpperCase() as ThinkingLevel },
            responseMimeType: "application/json",
            ...(opts.schema ? { responseJsonSchema: opts.schema } : {}),
          },
        }).catch((err: unknown) => {
          this.noteQuota(err);
          throw isDailyQuota(err) ? new GeminiBudgetError(`Gemini daily free-tier quota is used up (${quotaIds(err).join(", ")})`) : err;
        });
      },
      {
        // Google counts failed attempts (503 included) against the daily request quota, so retry sparingly.
        attempts: 3,
        baseMs: 5000,
        maxMs: 60_000,
        retryable: (err) => !(err instanceof GeminiBudgetError) && isTransient(err),
        delayHint: (err) => retryDelayMs(err),
        onRetry: (err, n, ms) => console.warn(`gemini retry ${n} in ${Math.round(ms / 1000)}s (${errorStatus(err) ?? "network"})`),
      },
    );
    const text = res.text ?? "";
    const model = res.modelVersion ?? this.model;
    this.resolvedModel = model;
    const usage: LlmUsage = {
      calls: 1,
      input_tokens: res.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0),
      cached_calls: 0,
      model,
    };
    Object.assign(this.totals, addUsage(this.totals, usage));
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ text, model, prompt_version: PROMPT_VERSION }));
    }
    return { text, usage };
  }
}

/** Gemini 429s carry a RetryInfo detail like "retryDelay": "37s". */
function retryDelayMs(err: unknown): number | null {
  if (errorStatus(err) !== 429) return null;
  const m = /retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/.exec(String((err as Error)?.message ?? ""));
  return m ? Math.ceil(Number(m[1]) * 1000) + 500 : null;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(trimmed);
}

export class GeminiExtractor implements Extractor {
  readonly name: string;
  private readonly fallback = new FuzzyExtractor();

  constructor(
    private readonly client: GeminiClient,
    private readonly matcher: FuzzyMatcher,
  ) {
    this.name = `gemini/${client.model}`;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const user = buildUserPrompt(input.catalog, input.utterances);
    const schema = extractionJsonSchema();
    let usage = emptyUsage(this.client.model);
    let repaired = false;
    let lastText = "";
    let lastError = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      const history = attempt === 0 ? undefined : [{ role: "user" as const, text: user }, { role: "model" as const, text: lastText }];
      let call: CallResult;
      try {
        call = await this.client.json({ system: SYSTEM_PROMPT, user: attempt === 0 ? user : repairPrompt(lastText, lastError), schema, ...(history ? { history } : {}) });
      } catch (e) {
        // Out of budget, or still overloaded after retries: degrade to the fuzzy extractor rather than fail the run.
        if (!(e instanceof GeminiBudgetError) && !isTransient(e)) throw e;
        const why = e instanceof GeminiBudgetError ? e.message : `Gemini unavailable after retries (${errorStatus(e) ?? "network"}).`;
        const fb = await this.fallback.extract(input);
        return { ...fb, usage, warnings: [`${why} Used fuzzy fallback; everything is in needs_review.`], raw: lastText, repaired, fallback: true };
      }
      usage = addUsage(usage, call.usage);
      lastText = call.text;
      let parsed: z.infer<typeof LlmExtraction>;
      try {
        parsed = LlmExtraction.parse(parseJson(call.text));
      } catch (e) {
        lastError = e instanceof z.ZodError ? z.prettifyError(e) : (e as Error).message;
        repaired = true;
        continue;
      }
      const v = validateEvents(parsed.events, input.utterances, input.catalog, this.matcher);
      if (v.unknownIds.length && attempt === 0) {
        // One repair retry for ids the fuzzy matcher could not place; otherwise keep the fuzzy result.
        lastError = `These catalog_id values are not in the MENU: ${v.unknownIds.join(", ")}`;
        repaired = true;
        continue;
      }
      return { events: v.events, usage: { ...usage, model: this.client.resolvedModel ?? usage.model }, warnings: v.warnings, raw: parsed, repaired, fallback: false, customer_language: parsed.customer_language };
    }

    // Repair failed: fall back to keyword + fuzzy matching (everything lands in needs_review).
    const fb = await this.fallback.extract(input);
    return { ...fb, usage, warnings: [`LLM output unusable after repair (${lastError.slice(0, 200)}); used fuzzy fallback`], raw: lastText, repaired, fallback: true };
  }
}

const BoundaryAnswer = z.object({ new_customer: z.boolean() });
const RoleAnswer = z.object({ crew_speaker: z.string() });

export class GeminiJudge implements BoundaryJudge, RoleJudge {
  constructor(private readonly client: GeminiClient) {}

  /** Out of budget: answer null so callers keep the rule-based decision. */
  private async ask(opts: Parameters<GeminiClient["json"]>[0]): Promise<CallResult | null> {
    try {
      return await this.client.json(opts);
    } catch (e) {
      if (e instanceof GeminiBudgetError) return null;
      throw e;
    }
  }

  async isNewCustomer(before: Utterance[], after: Utterance[]): Promise<boolean> {
    const user = `${formatUtterances(before)}\n----- does a new customer start here? -----\n${formatUtterances(after)}`;
    const res = await this.ask({
      system: BOUNDARY_PROMPT,
      user,
      schema: { type: "object", properties: { new_customer: { type: "boolean" } }, required: ["new_customer"] },
    });
    if (!res) return false;
    try {
      return BoundaryAnswer.parse(parseJson(res.text)).new_customer;
    } catch {
      return false;
    }
  }

  async pickCrew(samples: { speaker: string; lines: string[] }[]): Promise<string | null> {
    const user = samples.map((s) => `${s.speaker}:\n${s.lines.map((l) => `  - ${l}`).join("\n")}`).join("\n\n");
    const res = await this.ask({
      system: ROLE_PROMPT,
      user,
      schema: { type: "object", properties: { crew_speaker: { type: "string" } }, required: ["crew_speaker"] },
    });
    if (!res) return null;
    try {
      const pick = RoleAnswer.parse(parseJson(res.text)).crew_speaker;
      return samples.some((s) => s.speaker === pick) ? pick : null;
    } catch {
      return null;
    }
  }
}
