/** Wires config, catalog, providers, store and webhook into one object the CLI and the web app share. */
import path from "node:path";
import { anyPlaceholders, getConfig, type SandboxConfig } from "@serv/config";
import { LocalBlobStore } from "./data/blob-store";
import { DataStore } from "./data/store";
import { FuzzyExtractor } from "./extract/fuzzy-extractor";
import { GeminiClient, GeminiExtractor, GeminiJudge } from "./extract/gemini";
import { OracleExtractor } from "./extract/oracle";
import type { Extractor } from "./extract/types";
import type { Catalog } from "./menu/catalog";
import { loadCatalog } from "./menu/load";
import { FuzzyMatcher } from "./menu/fuzzy";
import type { BoundaryJudge } from "./segment/segment";
import { openDb, type DB } from "./store/db";
import { DeepgramStreamingTranscriber, sdkSocketFactory } from "./lane/deepgram-stream";
import { FileOrLiveTranscriber } from "./lane/file-transcriber";
import { ScriptStreamingTranscriber } from "./lane/script-transcriber";
import type { StreamingTranscriber } from "./lane/types";
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
  /** Stream file replays to Deepgram live instead of its prerecorded API (costs credit on every run; no cache). */
  liveFiles?: boolean;
  log?: (msg: string) => void;
}

export interface Engine {
  cfg: SandboxConfig;
  catalog: Catalog;
  matcher: FuzzyMatcher;
  db: DB;
  transcriber: Transcriber;
  /** Live path: one streaming connection per session (Deepgram live, or the free script transcriber). */
  streaming: StreamingTranscriber;
  extractor: Extractor;
  judge: BoundaryJudge | null;
  gemini: GeminiClient | null;
  deliverer: Deliverer;
  /** Long-term data store: blobs under DATA_DIR/blobs, catalog in SQLite. */
  data: DataStore;
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
  let streaming: StreamingTranscriber;
  if (transcriberKind === "deepgram") {
    if (!cfg.deepgramApiKey) throw new ConfigError("DEEPGRAM_API_KEY is not set. Add it to .env, or use --transcriber script for fixture audio");
    transcriber = new DeepgramTranscriber(cfg.deepgramApiKey, judge);
    const live = new DeepgramStreamingTranscriber(sdkSocketFactory(cfg.deepgramApiKey), {
      keyterms: loadCatalog(cfg.paths.menu).keyterms(),
      language: cfg.language,
      idleCloseS: cfg.deepgramIdleCloseS,
      log,
    });
    // Files: prerecorded API, cached (reruns are free). Live connections: streaming.
    streaming = opts.liveFiles
      ? live
      : new FileOrLiveTranscriber(transcriber, live, {
          channelMap: cfg.channelMap.value,
          audioStartUtc: cfg.audioStartUtc.value,
          keyterms: loadCatalog(cfg.paths.menu).keyterms(),
          language: cfg.language,
          cacheDir: cfg.paths.cacheDir,
          lowConfWord: cfg.lowConfWord,
        });
  } else {
    transcriber = new ScriptTranscriber();
    streaming = new ScriptStreamingTranscriber();
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
  const data = new DataStore(db, new LocalBlobStore(path.join(cfg.paths.dataDir, "blobs")), {
    pipelineVersion: cfg.pipelineVersion,
    budgetBytes: cfg.data.budgetBytes,
    retention: cfg.data.retention,
  });
  return { cfg, catalog, matcher, db, transcriber, streaming, extractor, judge, gemini, deliverer, data, placeholders: anyPlaceholders(cfg), log };
}
