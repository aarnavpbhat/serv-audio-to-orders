import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GoogleGenAI, HarmBlockThreshold, HarmCategory, type GenerateContentResponse, type SafetySetting, type ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { FuzzyMatcher } from "../menu/fuzzy";
import { errorStatus, isRetryableError, sleep, withRetry } from "../lib/retry";
import type { Utterance } from "../schemas";
import type { BoundaryJudge } from "../segment/segment";
import type { RoleJudge } from "../transcribe/types";
import { FuzzyExtractor } from "./fuzzy-extractor";
import { LlmExtraction, extractionJsonSchema } from "./llm-schema";
import { BOUNDARY_PROMPT, LINE_ROLES_PROMPT, PROMPT_VERSION, ROLE_PROMPT, SYSTEM_PROMPT, buildUserPrompt, formatUtterances, repairPrompt } from "./prompt";
import { addUsage, emptyUsage, type ExtractInput, type ExtractResult, type Extractor, type LlmCallRecord, type LlmUsage } from "./types";
import { validateEvents } from "./validate";

interface CallResult {
  text: string;
  usage: LlmUsage;
  record: LlmCallRecord;
}

/** Per-request deadline; a hung call is retried as transient, then the caller falls back. */
const CALL_TIMEOUT_MS = 90_000;

/**
 * Pinned on every call so a provider default change cannot
 * silently shift what gets blocked. BLOCK_ONLY_HIGH: drive-thru orders are benign text.
 */
export const SAFETY_SETTINGS: SafetySetting[] = [
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

/** Gemini refused on safety grounds. Not transient: never retried; callers degrade with a marker. */
export class GeminiSafetyBlockedError extends Error {
  constructor(
    readonly correlationId: string,
    readonly site: string,
  ) {
    super(`Gemini blocked the request on safety grounds at ${site} (correlation ${correlationId})`);
    this.name = "GeminiSafetyBlockedError";
  }
}

/** Every block-type finishReason, so a block is never mistaken for malformed output. */
const BLOCK_FINISH_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/** One structured line per event on stderr, so stdout stays clean for `--json` output. */
export function logLine(severity: "INFO" | "WARNING" | "ERROR", message: string, fields: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ severity, message, ...fields })}\n`);
}

/** Throws (after one `gemini_safety_block` log line, never the prompt) when the response was blocked. */
export function checkSafetyBlock(response: GenerateContentResponse, site: string): void {
  const blockReason = response.promptFeedback?.blockReason;
  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (!blockReason && !BLOCK_FINISH_REASONS.has(finishReason ?? "")) return;
  const categories = [...(response.promptFeedback?.safetyRatings ?? []), ...(candidate?.safetyRatings ?? [])]
    .filter((r) => r.probability && r.probability !== "NEGLIGIBLE")
    .map((r) => ({ category: r.category ?? "UNKNOWN", probability: r.probability }));
  const correlationId = randomUUID();
  logLine("WARNING", "gemini_safety_block", { event: "gemini_safety_block", correlationId, site, blockReason: blockReason ?? null, finishReason: finishReason ?? null, categories });
  throw new GeminiSafetyBlockedError(correlationId, site);
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

  /** Live calls never wait for a slot: true if one is free now (and takes it). */
  private takeSlotNow(): boolean {
    const now = Date.now();
    if (this.nextSlot > now) return false;
    this.nextSlot = now + 60_000 / Math.max(1, this.rpm);
    return true;
  }

  private async throttle(): Promise<void> {
    const gap = 60_000 / Math.max(1, this.rpm);
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + gap;
    if (wait > 0) await sleep(wait);
  }

  async json(opts: {
    site: string;
    system: string;
    user: string;
    schema?: Record<string, unknown>;
    history?: { role: "user" | "model"; text: string }[];
    /**
     * Live tie-breakers: one attempt, this deadline, and no waiting for a per-minute
     * slot (a busy slot throws GeminiBudgetError so the caller's rules decide).
     */
    live?: { timeoutMs: number };
  }): Promise<CallResult> {
    const contents = [...(opts.history ?? []), { role: "user" as const, text: opts.user }].map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
    const key = createHash("sha256")
      .update(JSON.stringify({ m: this.model, t: this.thinking, s: opts.system, c: contents, j: opts.schema ?? null }))
      .digest("hex")
      .slice(0, 24);
    const record = (text: string, usage: LlmUsage, cached: boolean): LlmCallRecord => ({
      request_hash: key,
      site: opts.site,
      model: usage.model,
      prompt_version: PROMPT_VERSION,
      system_sha256: createHash("sha256").update(opts.system).digest("hex"),
      contents: [...(opts.history ?? []), { role: "user" as const, text: opts.user }],
      response_text: text,
      usage,
      cached,
      at: new Date().toISOString(),
    });
    const file = this.cacheDir ? path.join(this.cacheDir, `${key}.json`) : null;
    if (file && existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, "utf8")) as { text: string; model: string };
      const usage = { ...emptyUsage(hit.model), cached_calls: 1 };
      Object.assign(this.totals, addUsage(this.totals, usage));
      return { text: hit.text, usage, record: record(hit.text, usage, true) };
    }

    const started = Date.now();
    let outcome = "ok";
    let res: GenerateContentResponse;
    try {
      res = await withRetry(
      async () => {
        if (opts.live) {
          if (!this.takeSlotNow()) throw new GeminiBudgetError("Gemini per-minute slot busy; the rules decide this one");
        } else await this.throttle();
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
            safetySettings: SAFETY_SETTINGS,
            abortSignal: AbortSignal.timeout(opts.live?.timeoutMs ?? CALL_TIMEOUT_MS),
          },
        }).catch((err: unknown) => {
          this.noteQuota(err);
          throw isDailyQuota(err) ? new GeminiBudgetError(`Gemini daily free-tier quota is used up (${quotaIds(err).join(", ")})`) : err;
        });
      },
      {
        // Google counts failed attempts (503 included) against the daily request quota, so retry sparingly.
        maxRetries: opts.live ? 0 : 2,
        initialDelay: 5000,
        maxDelay: 60_000,
        retryOn: (err) => !(err instanceof GeminiBudgetError) && isRetryableError(err),
        delayHint: (err) => retryDelayMs(err),
        operationName: `gemini ${this.model} ${opts.site}`,
      },
    );
      checkSafetyBlock(res, opts.site);
      if (!res.text) outcome = "empty";
    } catch (e) {
      outcome = e instanceof GeminiSafetyBlockedError ? "safety_block" : e instanceof GeminiBudgetError ? "budget" : "error";
      throw e;
    } finally {
      // ERROR only for a genuine outage; blocks and spent budget are expected and log WARNING.
      logLine(outcome === "ok" ? "INFO" : outcome === "error" ? "ERROR" : "WARNING", "llm_call", { event: "llm_call", site: opts.site, model: this.model, latencyMs: Date.now() - started, outcome });
    }
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
    return { text, usage, record: record(text, usage, false) };
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
    const calls: LlmCallRecord[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const history = attempt === 0 ? undefined : [{ role: "user" as const, text: user }, { role: "model" as const, text: lastText }];
      let call: CallResult;
      try {
        call = await this.client.json({ site: attempt === 0 ? "extract" : "extract_repair", system: SYSTEM_PROMPT, user: attempt === 0 ? user : repairPrompt(lastText, lastError), schema, ...(history ? { history } : {}) });
      } catch (e) {
        // Out of budget, or still overloaded after retries: degrade to the fuzzy extractor rather than fail the run.
        if (!(e instanceof GeminiBudgetError) && !(e instanceof GeminiSafetyBlockedError) && !(e instanceof Error && isRetryableError(e))) throw e;
        const why = e instanceof GeminiBudgetError || e instanceof GeminiSafetyBlockedError ? e.message : `Gemini unavailable after retries (${errorStatus(e) ?? "network"}).`;
        const fb = await this.fallback.extract(input);
        return { ...fb, usage, warnings: [`${why} Used fuzzy fallback; everything is in needs_review.`], raw: lastText, repaired, fallback: true, calls };
      }
      usage = addUsage(usage, call.usage);
      calls.push(call.record);
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
      return { events: v.events, usage: { ...usage, model: this.client.resolvedModel ?? usage.model }, warnings: v.warnings, raw: parsed, repaired, fallback: false, customer_language: parsed.customer_language, calls };
    }

    // Repair failed: fall back to keyword + fuzzy matching (everything lands in needs_review).
    const fb = await this.fallback.extract(input);
    return { ...fb, usage, warnings: [`LLM output unusable after repair (${lastError.slice(0, 200)}); used fuzzy fallback`], raw: lastText, repaired, fallback: true, calls };
  }
}

const BoundaryAnswer = z.object({ new_customer: z.boolean() });
const RoleAnswer = z.object({ crew_speaker: z.string() });
const LineRolesAnswer = z.object({ roles: z.array(z.enum(["crew", "customer"])) });

export class GeminiJudge implements BoundaryJudge, RoleJudge {
  constructor(private readonly client: GeminiClient) {}

  /** Out of budget or blocked: answer null so callers keep the rule-based decision. */
  private async ask(opts: Parameters<GeminiClient["json"]>[0]): Promise<CallResult | null> {
    try {
      return await this.client.json(opts);
    } catch (e) {
      if (e instanceof GeminiBudgetError || e instanceof GeminiSafetyBlockedError) return null;
      throw e;
    }
  }

  /** Parse a judge answer; an unusable one is logged (never silent) and the rule-based decision stands. */
  private parse<T>(site: string, text: string, schema: z.ZodType<T>): T | null {
    try {
      return schema.parse(parseJson(text));
    } catch (e) {
      logLine("WARNING", "llm_output_unusable", { event: "llm_output_unusable", site, detail: (e as Error).message.slice(0, 200) });
      return null;
    }
  }

  async isNewCustomer(before: Utterance[], after: Utterance[], live?: { timeoutMs: number }): Promise<boolean> {
    return (await this.newCustomerAnswer(before, after, live)) ?? false;
  }

  /**
   * Live tie-breaker: one attempt within the deadline. Null when there is no answer
   * (timeout, busy slot, budget, unusable output), so the tracker's rules decide.
   */
  async newCustomerAnswer(before: Utterance[], after: Utterance[], live?: { timeoutMs: number }): Promise<boolean | null> {
    const user = `${formatUtterances(before)}\n----- does a new customer start here? -----\n${formatUtterances(after)}`;
    let res: CallResult | null;
    try {
      res = await this.ask({
        site: live ? "segment_boundary_live" : "segment_boundary",
        ...(live ? { live } : {}),
      system: BOUNDARY_PROMPT,
      user,
        schema: { type: "object", properties: { new_customer: { type: "boolean" } }, required: ["new_customer"] },
      });
    } catch (e) {
      if (!live) throw e;
      logLine("WARNING", "judge_no_answer", { event: "judge_no_answer", site: "segment_boundary_live", detail: (e as Error).message.slice(0, 200) });
      return null;
    }
    if (!res) return null;
    return this.parse("segment_boundary", res.text, BoundaryAnswer)?.new_customer ?? null;
  }

  /** Plan D7: one role per line when diarization collapsed. Null when there is no usable answer. */
  async labelLines(lines: string[]): Promise<("crew" | "customer")[] | null> {
    if (!lines.length) return [];
    const user = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
    const res = await this.ask({
      site: "line_roles",
      system: LINE_ROLES_PROMPT,
      user,
      schema: { type: "object", properties: { roles: { type: "array", items: { type: "string", enum: ["crew", "customer"] } } }, required: ["roles"] },
    });
    if (!res) return null;
    const roles = this.parse("line_roles", res.text, LineRolesAnswer)?.roles ?? null;
    return roles && roles.length === lines.length ? roles : null;
  }

  async pickCrew(samples: { speaker: string; lines: string[] }[]): Promise<string | null> {
    const user = samples.map((s) => `${s.speaker}:\n${s.lines.map((l) => `  - ${l}`).join("\n")}`).join("\n\n");
    const res = await this.ask({
      site: "role_pick",
      system: ROLE_PROMPT,
      user,
      schema: { type: "object", properties: { crew_speaker: { type: "string" } }, required: ["crew_speaker"] },
    });
    if (!res) return null;
    const pick = this.parse("role_pick", res.text, RoleAnswer)?.crew_speaker ?? null;
    return pick !== null && samples.some((s) => s.speaker === pick) ? pick : null;
  }
}
