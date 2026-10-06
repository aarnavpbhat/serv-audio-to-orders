/**
 * Replay a recording through the live path (plan D1): FileReplaySource -> lane
 * -> streaming transcriber -> conversations -> orders -> outbox.
 */
import path from "node:path";
import type { Engine } from "../engine";
import { addUsage, emptyUsage } from "../extract/types";
import { FileReplaySource, type ReplayOptions } from "../input/file-replay";
import { newId } from "../lib/ids";
import type { RunOrder } from "../orders/finalize";
import type { Segmentation, Transcript } from "../schemas";
import { insertRun, outboxForRun, updateRun, type OutboxRow } from "../store/db";
import { LaneManager } from "./manager";
import type { TrackerDecision } from "./tracker";
import type { StreamingTranscriber } from "./types";

export interface ReplayRunOptions extends ReplayOptions {
  transcriber: StreamingTranscriber;
  /** tracker (default) or batch (v1 segmentation, for parity checks). */
  mode?: "tracker" | "batch";
  deliver?: boolean;
  runId?: string;
}

export interface ReplayResult {
  run_id: string;
  transcript: Transcript;
  segmentation: Segmentation;
  /** Latest version of every order. */
  orders: RunOrder[];
  /** Every version built, in order (v1, then v2 on a reopen or late evidence). */
  versions: RunOrder[];
  decisions: TrackerDecision[];
  deliveries: OutboxRow[];
  usage: { deepgram_minutes: number; llm: ReturnType<typeof emptyUsage>; gemini_today: { day: string; requests: number; cap: number } | null };
  timings: Record<string, number>;
}

export async function replayFile(engine: Engine, file: string, opts: ReplayRunOptions): Promise<ReplayResult> {
  const { db } = engine;
  const runId = opts.runId ?? newId("run");
  const abs = path.resolve(file);
  const t0 = performance.now();
  const source = new FileReplaySource(abs, opts);
  if (!opts.runId) {
    insertRun(db, {
      id: runId,
      source_file: path.basename(abs),
      file_path: abs,
      options: { via: "lane", scenario: source.scenario.name, speed: opts.speed ?? "max", transcriber: opts.transcriber.name, extractor: engine.extractor.name },
    });
  }
  updateRun(db, runId, { status: "running", stage: "transcribe", transcriber: opts.transcriber.name, extractor: engine.extractor.name });
  try {
    const manager = new LaneManager({ engine, transcriber: opts.transcriber, runId, deliver: opts.deliver !== false, ...(opts.mode ? { mode: opts.mode } : {}) });
    for await (const m of source.messages()) await manager.handle(m);
    updateRun(db, runId, { stage: "extract" });
    await manager.end();

    const lanes = [...manager.lanes.values()];
    const lane = lanes[0];
    const transcript = lane?.transcript() ?? emptyTranscript(abs);
    const segmentation = lane?.segmentation() ?? { segments: [], boundaries: [], llm_calls: 0 };
    const orders = lanes.flatMap((l) => l.latestOrders);
    const versions = lanes.flatMap((l) => l.orders);
    updateRun(db, runId, { stage: "deliver", transcript, segmentation, audio: transcript.audio });
    await Promise.allSettled(lanes.flatMap((l) => l.sends));
    await engine.deliverer.settle();

    const llm = lanes.reduce((u, l) => addUsage(u, l.llm), emptyUsage(engine.gemini?.model ?? "none"));
    const ledger = engine.gemini?.ledger() ?? null;
    const usage = {
      deepgram_minutes: lanes.reduce((n, l) => n + l.audioMinutes, 0),
      llm,
      gemini_today: ledger ? { day: ledger.day, requests: ledger.requests, cap: engine.cfg.geminiDailyCap } : null,
    };
    const timings = { total_ms: Math.round(performance.now() - t0) };
    updateRun(db, runId, { status: "completed", stage: "done", usage, timings });
    return { run_id: runId, transcript, segmentation, orders, versions, decisions: lanes.flatMap((l) => l.decisions), deliveries: outboxForRun(db, runId), usage, timings };
  } catch (e) {
    updateRun(db, runId, { status: "failed", error: (e as Error).message });
    throw e;
  }
}

function emptyTranscript(file: string): Transcript {
  return {
    transcript_id: "tr_empty",
    source_file: path.basename(file),
    audio: { codec: "pcm_s16le", sample_rate: 16000, channels: 1, duration_s: 0 },
    audio_start_utc: new Date(0).toISOString(),
    timestamp_source: "recording_metadata",
    role_source: "script",
    stt: "none",
    language: null,
    utterances: [],
  };
}
