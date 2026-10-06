/** Wires config, catalog, providers, store and webhook into one object the CLI and the web app share. */
import path from "node:path";
import { anyPlaceholders, getConfig, type SandboxConfig } from "@serv/config";
import { FuzzyExtractor } from "./extract/fuzzy-extractor";
import { GeminiClient, GeminiExtractor, GeminiJudge } from "./extract/gemini";
import { OracleExtractor } from "./extract/oracle";
import type { Extractor } from "./extract/types";
import type { Catalog } from "./menu/catalog";
import { loadCatalog } from "./menu/load";
import { FuzzyMatcher } from "./menu/fuzzy";
import type { BoundaryJudge } from "./segment/segment";
import { openDb, type DB } from "./store/db";
import { DeepgramTranscriber } from "./transcribe/deepgram";
import { ScriptTranscriber } from "./transcribe/script";
import type { Transcriber } from "./transcribe/types";
import { Deliverer } from "./webhook/deliver";

export type TranscriberKind = "deepgram" | "script";
export type ExtractorKind = "gemini" | "fuzzy" | "oracle";

export interface EngineOptions {
  transcriber?: TranscriberKind;
  extractor?: ExtractorKind;
  /** Disable the LLM boundary / role tie-breakers. The oracle (ceiling) extractor implies this, so ceiling runs stay free. */
  noJudge?: boolean;
  log?: (msg: string) => void;
}

export interface Engine {
  cfg: SandboxConfig;
  catalog: Catalog;
  matcher: FuzzyMatcher;
  db: DB;
  transcriber: Transcriber;
  extractor: Extractor;
  judge: BoundaryJudge | null;
  gemini: GeminiClient | null;
  deliverer: Deliverer;
  placeholders: boolean;
  log: (msg: string) => void;
}

export class ConfigError extends Error {}

export function defaultTranscriber(cfg: SandboxConfig = getConfig()): TranscriberKind {
  return cfg.deepgramApiKey ? "deepgram" : "script";
}

export function defaultExtractor(cfg: SandboxConfig = getConfig()): ExtractorKind {
  return cfg.geminiApiKey ? "gemini" : "fuzzy";
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const cfg = getConfig();
  const log = opts.log ?? ((m: string) => console.log(m));
  const catalog = loadCatalog(cfg.paths.menu);
  const matcher = new FuzzyMatcher(catalog);
  const db = openDb(cfg.paths.dbPath);

  const extractorKind = opts.extractor ?? defaultExtractor(cfg);
  const gemini = cfg.geminiApiKey
    ? new GeminiClient(cfg.geminiApiKey, cfg.geminiModel, cfg.geminiRpm, path.join(cfg.paths.cacheDir, "llm"), { cap: cfg.geminiDailyCap, file: path.join(cfg.paths.dataDir, "gemini-ledger.json") }, cfg.geminiThinking)
    : null;
  if (extractorKind === "gemini" && !gemini) throw new ConfigError("GEMINI_API_KEY is not set. Add it to .env, or use --extractor fuzzy");
  const judge = gemini && !opts.noJudge && extractorKind !== "oracle" ? new GeminiJudge(gemini) : null;

  const transcriberKind = opts.transcriber ?? defaultTranscriber(cfg);
  let transcriber: Transcriber;
  if (transcriberKind === "deepgram") {
    if (!cfg.deepgramApiKey) throw new ConfigError("DEEPGRAM_API_KEY is not set. Add it to .env, or use --transcriber script for fixture audio");
    transcriber = new DeepgramTranscriber(cfg.deepgramApiKey, judge);
  } else {
    transcriber = new ScriptTranscriber();
  }

  const extractor: Extractor =
    extractorKind === "gemini" && gemini
      ? new GeminiExtractor(gemini, matcher)
      : extractorKind === "oracle"
        ? new OracleExtractor(cfg.paths.fixturesDir)
        : new FuzzyExtractor();
  const deliverer = new Deliverer(
    db,
    {
      url: cfg.webhookUrl.value,
      secret: cfg.webhookSecret.value,
      timeoutMs: cfg.webhook.timeoutMs,
      fastScheduleS: cfg.webhook.fastScheduleS,
      slowScheduleS: cfg.webhook.slowScheduleS,
      userAgent: cfg.webhook.userAgent,
    },
    { log },
  );
  return { cfg, catalog, matcher, db, transcriber, extractor, judge, gemini, deliverer, placeholders: anyPlaceholders(cfg), log };
}
