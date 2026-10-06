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
import type { LaneOptions } from "./lane";
import { LaneManager } from "./manager";
import type { TrackerDecision } from "./tracker";
import { sttName, type StreamingTranscriber } from "./types";

export interface ReplayRunOptions extends ReplayOptions {
  transcriber: StreamingTranscriber;
  deliver?: boolean;
  runId?: string;
  /** Keep order audio, provider messages and session events in the data store, as the live server does. */
  record?: boolean;
  /** Lane updates (the CLI feeds the web app's live view with them). */
  onUpdate?: LaneOptions["onUpdate"];
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
  /** Real-time replays only: conversation end -> first webhook 2xx, per order (ms). */
  closeLatencyMs: number[];
}

export async function replayFile(engine: Engine, file: string, opts: ReplayRunOptions): Promise<ReplayResult> {
  const { db } = engine;
  const runId = opts.runId ?? newId("run");
  const abs = path.resolve(file);
  const t0 = performance.now();
  const source = new FileReplaySource(abs, opts);
  const stt = sttName(opts.transcriber, { sourceType: "file_replay", sourceRef: abs });
  if (!opts.runId) {
    insertRun(db, {
      id: runId,
      source_file: path.basename(abs),
      file_path: abs,
      options: { via: "lane", scenario: source.scenario.name, speed: opts.speed ?? "max", transcriber: stt, extractor: engine.extractor.name },
    });
  }
  updateRun(db, runId, { status: "running", stage: "transcribe", transcriber: stt, extractor: engine.extractor.name });
  try {
    const manager = new LaneManager({ engine, transcriber: opts.transcriber, runId, deliver: opts.deliver !== false, ...(opts.record ? { record: true } : {}), ...(opts.onUpdate ? { onUpdate: opts.onUpdate } : {}) });
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
    // At 1x (or Nx), recording time maps to wall time, so the close latency is measurable.
    const deliveries = outboxForRun(db, runId);
    const closeLatencyMs: number[] = [];
    const speed = opts.speed ?? "max";
    if (speed !== "max" && source.wallStartMs !== null && source.anchorMs !== null) {
      for (const o of orders) {
        const v1 = deliveries.find((d) => d.order_id === o.order.order_id && d.order_version === 1);
        if (!v1?.delivered_at) continue;
        const endedWall = source.wallStartMs + (Date.parse(o.payload.times.ended_at) - source.anchorMs) / speed;
        closeLatencyMs.push(Math.round(v1.delivered_at - endedWall));
      }
    }
    updateRun(db, runId, { status: "completed", stage: "done", usage, timings });
    updateRun(db, runId, { timings: { ...timings, ...latencySummary(closeLatencyMs) } });
    return { run_id: runId, transcript, segmentation, orders, versions, decisions: lanes.flatMap((l) => l.decisions), deliveries, usage, timings, closeLatencyMs };
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

/** p50 and p95 of close latency, for run timings and reports. */
export function latencySummary(ms: number[]): { close_latency_p50_ms?: number; close_latency_p95_ms?: number } {
  if (!ms.length) return {};
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  return { close_latency_p50_ms: at(0.5), close_latency_p95_ms: at(0.95) };
}
