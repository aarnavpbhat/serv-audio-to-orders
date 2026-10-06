/** One audio file through all stages: ingest -> transcribe -> segment -> extract -> build -> post-process -> deliver. */
import path from "node:path";
import type { Engine } from "./engine";
import { addUsage, emptyUsage, type LlmUsage } from "./extract/types";
import { ingest } from "./ingest/ingest";
import { newId } from "./lib/ids";
import { channelRoles, finalizeConversation, type RunOrder } from "./orders/finalize";
import type { Segmentation, Transcript } from "./schemas";
import { segmentTranscript } from "./segment/segment";
import { insertRun, outboxForRun, updateRun, type OutboxRow } from "./store/db";
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

export type Stage = "ingest" | "transcribe" | "segment" | "extract" | "deliver" | "done";

export async function runPipeline(engine: Engine, file: string, opts: RunOptions = {}, onStage?: (s: Stage) => void): Promise<RunResult> {
  const { cfg, db, log } = engine;
  const runId = opts.runId ?? newId("run");
  const sessionId = newId("ses");
  const receivedAt = new Date().toISOString();
  const abs = path.resolve(file);
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const lap = (name: string, since: number) => (timings[name] = Math.round(performance.now() - since));
  const stage = (s: Stage) => {
    updateRun(db, runId, { status: s === "done" ? "completed" : "running", stage: s });
    onStage?.(s);
  };

  if (!opts.runId) {
    insertRun(db, {
      id: runId,
      source_file: path.basename(abs),
      file_path: abs,
      options: { transcriber: engine.transcriber.name, extractor: engine.extractor.name, ...opts },
    });
  }
  updateRun(db, runId, { transcriber: engine.transcriber.name, extractor: engine.extractor.name });

  try {
    stage("ingest");
    let t = performance.now();
    const input = await ingest(abs, { audioStartUtc: opts.audioStartUtc ?? cfg.audioStartUtc.value });
    lap("ingest_ms", t);
    updateRun(db, runId, { file_hash: input.hash, audio: input.audio });

    stage("transcribe");
    t = performance.now();
    const channelMap = opts.channelMap === undefined ? cfg.channelMap.value : opts.channelMap;
    const tr = await engine.transcriber.transcribe(input, {
      channelMap,
      keyterms: engine.catalog.keyterms(),
      language: cfg.language,
      cacheDir: cfg.paths.cacheDir,
      lowConfWord: cfg.lowConfWord,
      refresh: opts.refresh ?? false,
    });
    lap("transcribe_ms", t);
    const transcript = tr.transcript;
    updateRun(db, runId, { transcript });
    log(`transcribed ${transcript.utterances.length} utterances (${tr.usage.provider}, ${tr.usage.cached ? "cached" : `${tr.usage.audio_minutes} min billed`})`);

    stage("segment");
    t = performance.now();
    const segmentation = await segmentTranscript(transcript, { ...cfg.segment, lowAudioQualityMeanConf: cfg.lowAudioQualityMeanConf }, engine.judge);
    lap("segment_ms", t);
    updateRun(db, runId, { segmentation });
    log(`found ${segmentation.segments.length} conversation(s)`);

    stage("extract");
    const results: RunOrder[] = [];
    const sends: Promise<OutboxRow>[] = [];
    let llm = emptyUsage(engine.gemini?.model ?? "none");
    const beforeExtract = (timings.ingest_ms ?? 0) + (timings.transcribe_ms ?? 0) + (timings.segment_ms ?? 0);
    const tExtract = performance.now();
    for (const seg of segmentation.segments) {
      const ts = performance.now();
      const done = await finalizeConversation(engine, {
        runId,
        segment: seg,
        transcript,
        session: {
          sessionId,
          storeId: cfg.storeId.value,
          laneId: cfg.laneId.value,
          // File recordings carry their start time as metadata (env, filename or mtime).
          timeBasis: "recording_metadata",
          sessionOffsetS: 0,
          source: { type: "file_replay", codecIn: transcript.audio.codec, channels: transcript.audio.channels, channelRoles: channelRoles(transcript.audio.channels, channelMap) },
        },
        levelsDb: input.levels_db,
        receivedAt,
        audioFile: abs,
        deliver: opts.deliver !== false,
        latencyBaseMs: beforeExtract + (ts - tExtract),
      });
      llm = addUsage(llm, done.usage);
      results.push(...done.orders);
      sends.push(...done.sends);
    }
    timings.extract_ms = Math.round(performance.now() - tExtract);

    stage("deliver");
    t = performance.now();
    await Promise.allSettled(sends);
    lap("deliver_ms", t);
    timings.total_ms = Math.round(performance.now() - t0);

    const ledger = engine.gemini?.ledger() ?? null;
    const gemini_today = ledger ? { ...ledger, cap: cfg.geminiDailyCap } : null;
    const usage: RunUsage = { stt: tr.usage, llm, segmentation_llm_calls: segmentation.llm_calls, gemini_today };
    updateRun(db, runId, { usage, timings });
    stage("done");
    return { run_id: runId, transcript, segmentation, orders: results, deliveries: outboxForRun(db, runId), usage, timings };
  } catch (e) {
    updateRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}
