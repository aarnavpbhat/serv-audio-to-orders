/**
 * pnpm pipeline run <file> and the web app's runs (plan D1): a file goes
 * through the live path, replayed at max speed into a lane, so files and live
 * feeds share one tracker, finalize and delivery. The batch path is retired.
 */
import path from "node:path";
import { DEFAULT_SCENARIO } from "./input/scenario";
import type { ChannelRole } from "./input/types";
import type { Engine } from "./engine";
import type { LlmUsage } from "./extract/types";
import { probeAudio } from "./ingest/probe";
import { FileOrLiveTranscriber } from "./lane/file-transcriber";
import { replayFile } from "./lane/replay";
import type { StreamingTranscriber } from "./lane/types";
import type { RunOrder } from "./orders/finalize";
import type { Segmentation, Transcript } from "./schemas";
import type { OutboxRow } from "./store/db";
import type { TranscribeUsage } from "./transcribe/types";

export type { RunOrder } from "./orders/finalize";
export { channelRoles, segmentContext, transcriptSignals, type AudioQuality } from "./orders/finalize";

export interface RunOptions {
  runId?: string;
  channelMap?: Record<number, "crew" | "customer"> | null;
  audioStartUtc?: string | null;
  deliver?: boolean;
  /** Ignore cached Deepgram responses. */
  refresh?: boolean;
  /** Cancel button: stops the replay (see replayFile). */
  signal?: AbortSignal;
}

export interface RunUsage {
  stt: TranscribeUsage;
  llm: LlmUsage;
  segmentation_llm_calls: number;
  /** Gemini requests sent today (Pacific) against GEMINI_DAILY_CAP. */
  gemini_today: { day: string; requests: number; cap: number; tier: string; exhausted: boolean } | null;
}

export interface RunResult {
  run_id: string;
  transcript: Transcript;
  segmentation: Segmentation;
  orders: RunOrder[];
  deliveries: OutboxRow[];
  usage: RunUsage;
  timings: Record<string, number>;
}

export type Stage = "ingest" | "transcribe" | "extract" | "deliver" | "done";

export async function runPipeline(engine: Engine, file: string, opts: RunOptions = {}, onStage?: (s: Stage) => void): Promise<RunResult> {
  const { cfg } = engine;
  const abs = path.resolve(file);
  onStage?.("ingest");
  // Empty, silent or corrupt files fail here with a clear IngestError, before any provider is called.
  const info = await probeAudio(abs);
  const channelMap = opts.channelMap === undefined ? cfg.channelMap.value : opts.channelMap;
  const stereo = info.channels > 1 && channelMap !== null;
  const roles: ChannelRole[] | undefined = stereo ? [channelMap?.[0] ?? "mixed", channelMap?.[1] ?? "mixed"] : undefined;

  // Free script transcriber for fixtures; otherwise the provider's prerecorded API for the file (cached).
  let transcriber: StreamingTranscriber = engine.streaming;
  let files: FileOrLiveTranscriber | null = null;
  // A per-run transcriber when this run's channel map, start time or refresh differ from the engine's defaults.
  if (engine.streaming instanceof FileOrLiveTranscriber) {
    files = new FileOrLiveTranscriber(engine.transcriber, engine.streaming.live, {
      channelMap,
      audioStartUtc: opts.audioStartUtc ?? cfg.audioStartUtc.value,
      keyterms: engine.catalog.keyterms(),
      language: cfg.language,
      cacheDir: cfg.paths.cacheDir,
      lowConfWord: cfg.lowConfWord,
      refresh: opts.refresh ?? false,
    });
    transcriber = files;
  }
  onStage?.("transcribe");
  const r = await replayFile(engine, abs, {
    transcriber,
    scenario: { ...DEFAULT_SCENARIO, channels: stereo ? "stereo" : "mono" },
    ...(roles ? { channelRoles: roles } : {}),
    ...(opts.audioStartUtc ? { anchorAt: opts.audioStartUtc } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    deliver: opts.deliver !== false,
    speed: "max",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  onStage?.("done");
  const billed = (files?.billedMinutes ?? 0) + r.usage.deepgram_minutes;
  return {
    run_id: r.run_id,
    transcript: r.transcript,
    segmentation: r.segmentation,
    orders: r.orders,
    deliveries: r.deliveries,
    usage: {
      stt: { provider: transcriber.name, audio_minutes: Math.round(billed * 1000) / 1000, cached: billed === 0, role_llm_calls: 0 },
      llm: r.usage.llm,
      segmentation_llm_calls: r.segmentation.llm_calls,
      gemini_today: r.usage.gemini_today ? { ...r.usage.gemini_today, tier: engine.gemini?.ledger()?.tier ?? "unknown", exhausted: engine.gemini?.ledger()?.exhausted ?? false } : null,
    },
    timings: r.timings,
  };
}
