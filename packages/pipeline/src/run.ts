/** One audio file through all stages: ingest -> transcribe -> segment -> extract -> build -> post-process -> deliver. */
import path from "node:path";
import { replay, type AppliedEvent } from "./build/replay";
import type { Engine } from "./engine";
import { addUsage, emptyUsage, type ExtractResult, type LlmUsage } from "./extract/types";
import { ingest } from "./ingest/ingest";
import { snrDb } from "./ingest/probe";
import { newId } from "./lib/ids";
import { emptySignals, type OutcomeSignals } from "./postprocess/outcome";
import { postprocess, type SegmentContext } from "./postprocess/postprocess";
import type { Order, OrderEvent, OrderPayload, OutcomeEvidence, Segment, Segmentation, TimeBasis, Transcript, Utterance } from "./schemas";
import { isChatter, segmentTranscript } from "./segment/segment";
import { insertOrder, insertRun, outboxForRun, updateRun, type OutboxRow } from "./store/db";
import type { TranscribeUsage } from "./transcribe/types";
import { toPayload } from "./webhook/payload";

export interface RunOptions {
  runId?: string;
  channelMap?: Record<number, "crew" | "customer"> | null;
  audioStartUtc?: string | null;
  deliver?: boolean;
  /** Ignore cached Deepgram responses. */
  refresh?: boolean;
}

export interface RunOrder {
  order: Order;
  payload: OrderPayload;
  events: OrderEvent[];
  build_log: AppliedEvent[];
  warnings: string[];
  extraction: Pick<ExtractResult, "raw" | "repaired" | "fallback" | "warnings">;
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

export interface AudioQuality {
  lowAudioQualityMeanConf: number;
  lowAudioSnrDb: number;
  /** Per-window levels from ingest; omitted when not measured. */
  levelsDb?: number[];
}

/** Silences this long inside a conversation are recorded as context (never as an outcome on their own). */
export const SILENCE_CONTEXT_S = 10;

/** Outcome signals from a conversation's utterances: cues plus long silences as context. */
export function transcriptSignals(utts: Utterance[], trailingSilenceS: number, extra: Partial<OutcomeSignals> = {}): OutcomeSignals {
  const silence: OutcomeEvidence[] = [];
  for (let i = 1; i < utts.length; i++) {
    const gap = (utts[i]?.start_s ?? 0) - (utts[i - 1]?.end_s ?? 0);
    if (gap >= SILENCE_CONTEXT_S) silence.push({ type: "silence", at: utts[i - 1]?.end_utc ?? "", duration_s: Math.round(gap * 10) / 10, context_only: true });
  }
  const last = utts.at(-1);
  if (last && trailingSilenceS >= SILENCE_CONTEXT_S) silence.push({ type: "silence", at: last.end_utc, duration_s: Math.round(trailingSilenceS * 10) / 10, context_only: true });
  return {
    ...emptySignals(),
    ...extra,
    utterances: utts.map((u) => ({ id: u.id, speaker: u.speaker, text: u.text, start_s: u.start_s, start_utc: u.start_utc, chatter: isChatter(u) })),
    silence: [...silence, ...(extra.silence ?? [])],
  };
}

/** File recordings carry their start time as metadata (env, filename or mtime). */
export const fileTimeBasis = (_t: Transcript): TimeBasis => "recording_metadata";

export function segmentContext(seg: Segment, q: AudioQuality, utts: Utterance[] = []): SegmentContext {
  // ASR confidence stays high on loud, steady noise, so the measured noise floor counts too.
  const snr = q.levelsDb ? snrDb(q.levelsDb, seg.start_s, seg.end_s) : null;
  return {
    segment_id: seg.segment_id,
    start_s: seg.start_s,
    end_s: seg.end_s,
    utterance_ids: seg.utterance_ids,
    has_closing: seg.has_closing,
    truncated_start: seg.truncated_start,
    truncated_end: seg.truncated_end,
    non_english: seg.non_english,
    low_audio_quality: seg.mean_word_conf < q.lowAudioQualityMeanConf || (snr !== null && snr < q.lowAudioSnrDb),
    crosstalk_suspected: seg.crosstalk_suspected,
    signals: transcriptSignals(utts, seg.trailing_silence_s),
  };
}

/** Channel roles for the payload: from CHANNEL_MAP when channels are separate, else one mixed channel. */
export function channelRoles(channels: number, map: Record<number, "crew" | "customer"> | null | undefined): ("customer" | "crew" | "mixed")[] {
  if (!map || channels < 2) return ["mixed"];
  return Array.from({ length: channels }, (_, i) => map[i] ?? "mixed");
}

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
    const byId = new Map(transcript.utterances.map((u) => [u.id, u]));
    const results: RunOrder[] = [];
    const sends: Promise<OutboxRow>[] = [];
    let llm = emptyUsage(engine.gemini?.model ?? "none");
    const beforeExtract = (timings.ingest_ms ?? 0) + (timings.transcribe_ms ?? 0) + (timings.segment_ms ?? 0);

    for (const seg of segmentation.segments) {
      const ts = performance.now();
      const skip = new Set(seg.non_customer_ids);
      const all = seg.utterance_ids.map((id) => byId.get(id)).filter((u) => u !== undefined);
      const utterances = all.filter((u) => !skip.has(u.id));
      const ex = await engine.extractor.extract({ segment: seg, utterances, catalog: engine.catalog, audioFile: abs });
      llm = addUsage(llm, ex.usage);
      const state = replay(ex.events, engine.catalog);
      const ctx = segmentContext(seg, { lowAudioQualityMeanConf: cfg.lowAudioQualityMeanConf, lowAudioSnrDb: cfg.lowAudioSnrDb, levelsDb: input.levels_db }, all);
      // ASR language tags miss short or mixed-language turns; the model's reading counts too.
      if (ex.customer_language && !/^en\b/i.test(ex.customer_language)) ctx.non_english = true;
      const orders = postprocess(state, ctx, {
        catalog: engine.catalog,
        matcher: engine.matcher,
        thresholds: cfg.thresholds.value,
        taxRate: cfg.taxRate.value,
        totalTolerance: cfg.totalTolerance,
        placeholders: engine.placeholders,
        reviewCap: cfg.reviewCap,
        newOrderId: () => newId("ord"),
        newGroupId: () => newId("grp"),
      });
      const latency = Math.round(beforeExtract + (performance.now() - ts));
      for (const order of orders) {
        const payload = toPayload(order, {
          transcript,
          storeId: cfg.storeId.value,
          laneId: cfg.laneId.value,
          sessionId,
          timeBasis: fileTimeBasis(transcript),
          receivedAt,
          finalizedAt: new Date().toISOString(),
          source: {
            type: "file_replay",
            codecIn: transcript.audio.codec,
            channels: transcript.audio.channels,
            channelRoles: channelRoles(transcript.audio.channels, channelMap),
          },
          stt: engine.transcriber.name,
          extractor: engine.extractor.name,
          menuVersion: engine.catalog.version,
          pipelineVersion: cfg.pipelineVersion,
          latencyMs: latency,
          nonCustomerIds: skip,
        });
        const warnings = [...ex.warnings, ...state.warnings];
        insertOrder(db, {
          order_id: order.order_id,
          version: 1,
          run_id: runId,
          segment_id: seg.segment_id,
          status: order.status,
          payload: JSON.stringify(payload),
          events: JSON.stringify(ex.events),
          extraction: JSON.stringify({ raw: ex.raw, repaired: ex.repaired, fallback: ex.fallback, warnings }),
          build_log: JSON.stringify(state.log),
        });
        results.push({ order, payload, events: ex.events, build_log: state.log, warnings, extraction: { raw: ex.raw, repaired: ex.repaired, fallback: ex.fallback, warnings } });
        log(`  ${seg.segment_id} -> ${order.order_id} ${order.status} (${order.items.length} items, ${order.needs_review.length} review, ${order.not_ordered.length} not ordered)`);
        // Each order is sent the moment it is built.
        if (opts.deliver !== false) {
          const id = engine.deliverer.enqueue(payload, runId);
          sends.push(engine.deliverer.deliver(id));
        }
      }
    }
    timings.extract_ms = Math.round(performance.now() - t0) - beforeExtract;

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
