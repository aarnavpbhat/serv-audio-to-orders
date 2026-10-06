/**
 * One finished conversation -> order(s) -> outbox. Shared by the lane (live and
 * replay) and the file path: extract events, replay(), postprocess (buckets,
 * outcome, review), format the payload, store the version, deliver.
 */
import type { AppliedEvent } from "../build/replay";
import { replay } from "../build/replay";
import type { Engine } from "../engine";
import { snrDb } from "../ingest/probe";
import { newId } from "../lib/ids";
import { emptySignals, type OutcomeSignals } from "../postprocess/outcome";
import { postprocess, type SegmentContext } from "../postprocess/postprocess";
import type { CorrectionReason, Flag, Order, OrderEvent, OrderPayload, Segment, Transcript, Utterance } from "../schemas";
import { isChatter } from "../segment/segment";
import { insertOrder, type OutboxRow } from "../store/db";
import { emptyUsage, type ExtractResult, type LlmUsage } from "../extract/types";
import { toPayload, type PayloadContext } from "../webhook/payload";

export interface RunOrder {
  order: Order;
  payload: OrderPayload;
  events: OrderEvent[];
  build_log: AppliedEvent[];
  warnings: string[];
  extraction: Pick<ExtractResult, "raw" | "repaired" | "fallback" | "warnings">;
}

/** Silences this long inside a conversation are recorded as context (never as an outcome on their own). */
export const SILENCE_CONTEXT_S = 10;

export interface AudioQuality {
  lowAudioQualityMeanConf: number;
  lowAudioSnrDb: number;
  /** Per-window levels (100 ms) on the transcript's time axis; omitted when not measured. */
  levelsDb?: number[];
}

/** Outcome signals from a conversation's utterances: cues plus long silences as context. */
export function transcriptSignals(utts: Utterance[], trailingSilenceS: number, extra: Partial<OutcomeSignals> = {}): OutcomeSignals {
  const silence: OutcomeSignals["silence"] = [];
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

export function segmentContext(seg: Segment, q: AudioQuality, utts: Utterance[] = [], extra: Partial<OutcomeSignals> = {}): SegmentContext {
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
    signals: transcriptSignals(utts, seg.trailing_silence_s, extra),
  };
}

export interface ConversationSession {
  sessionId: string;
  storeId: string;
  laneId: string;
  timeBasis: PayloadContext["timeBasis"];
  /** Seconds from the session anchor to the transcript's audio_start_utc. */
  sessionOffsetS: number;
  source: PayloadContext["source"];
}

export interface FinalizeInput {
  runId: string;
  segment: Segment;
  /** Utterances with times on one axis (audio_start_utc + start_s). Must include the segment's. */
  transcript: Transcript;
  session: ConversationSession;
  levelsDb?: number[];
  /** Vehicle and stream evidence from the lane; silences inside the conversation are added here. */
  signals?: Partial<OutcomeSignals>;
  extraFlags?: Flag[];
  rolesLowAgreement?: boolean;
  /** When the first audio of this conversation arrived (processing time). */
  receivedAt: string;
  /** Fixture audio path, for the oracle extractor. */
  audioFile?: string;
  /** Order ids to keep (first minted when the conversation opened; split parts follow). */
  orderIds?: string[];
  groupId?: string | null;
  version?: number;
  correctionReason?: CorrectionReason | null;
  archiveUri?: string | null;
  deliver: boolean;
  /** Late evidence: build the new version only if the statuses would differ from these. */
  onlyIfStatusChanges?: string[];
  /** Reuse these events instead of extracting again (late evidence changes the outcome, not the items). */
  events?: OrderEvent[];
  /** Processing already spent before extraction (ingest, transcription, segmentation), for latency_ms. */
  latencyBaseMs?: number;
  now?: () => number;
}

export interface FinalizeResult {
  orders: RunOrder[];
  sends: Promise<OutboxRow>[];
  usage: LlmUsage;
}

export async function finalizeConversation(engine: Engine, input: FinalizeInput): Promise<FinalizeResult> {
  const { cfg, db } = engine;
  const now = input.now ?? Date.now;
  const t0 = performance.now();
  const seg = input.segment;
  const byId = new Map(input.transcript.utterances.map((u) => [u.id, u]));
  const skip = new Set(seg.non_customer_ids);
  const all = seg.utterance_ids.map((id) => byId.get(id)).filter((u) => u !== undefined);
  const utterances = all.filter((u) => !skip.has(u.id));

  const ex: ExtractResult = input.events
    ? { events: input.events, usage: emptyUsage("none"), warnings: [], raw: null, repaired: false, fallback: false }
    : await engine.extractor.extract({ segment: seg, utterances, catalog: engine.catalog, ...(input.audioFile ? { audioFile: input.audioFile } : {}) });
  const state = replay(ex.events, engine.catalog);
  const ctx = segmentContext(seg, { lowAudioQualityMeanConf: cfg.lowAudioQualityMeanConf, lowAudioSnrDb: cfg.lowAudioSnrDb, ...(input.levelsDb ? { levelsDb: input.levelsDb } : {}) }, all, input.signals);
  // ASR language tags miss short or mixed-language turns; the model's reading counts too.
  if (ex.customer_language && !/^en\b/i.test(ex.customer_language)) ctx.non_english = true;
  if (input.extraFlags?.length) ctx.extra_flags = input.extraFlags;
  if (input.rolesLowAgreement) ctx.roles_low_agreement = true;

  const keep = [...(input.orderIds ?? [])];
  const orders = postprocess(state, ctx, {
    catalog: engine.catalog,
    matcher: engine.matcher,
    thresholds: cfg.thresholds.value,
    taxRate: cfg.taxRate.value,
    totalTolerance: cfg.totalTolerance,
    placeholders: engine.placeholders,
    reviewCap: cfg.reviewCap,
    newOrderId: () => keep.shift() ?? newId("ord"),
    newGroupId: () => input.groupId ?? newId("grp"),
  });

  if (input.onlyIfStatusChanges && orders.map((o) => o.status).join() === input.onlyIfStatusChanges.join()) {
    return { orders: [], sends: [], usage: ex.usage };
  }
  const latency = Math.round((input.latencyBaseMs ?? 0) + (performance.now() - t0));
  const results: RunOrder[] = [];
  const sends: Promise<OutboxRow>[] = [];
  const version = input.version ?? 1;
  for (const order of orders) {
    const payload = toPayload(order, {
      transcript: input.transcript,
      storeId: input.session.storeId,
      laneId: input.session.laneId,
      sessionId: input.session.sessionId,
      timeBasis: input.session.timeBasis,
      sessionOffsetS: input.session.sessionOffsetS,
      receivedAt: input.receivedAt,
      finalizedAt: new Date(now()).toISOString(),
      archiveUri: input.archiveUri ?? null,
      source: input.session.source,
      stt: engine.transcriber.name,
      extractor: engine.extractor.name,
      menuVersion: engine.catalog.version,
      pipelineVersion: cfg.pipelineVersion,
      latencyMs: latency,
      nonCustomerIds: skip,
      orderVersion: version,
      correctionReason: input.correctionReason ?? null,
    });
    const warnings = [...ex.warnings, ...state.warnings];
    insertOrder(db, {
      order_id: order.order_id,
      version,
      run_id: input.runId,
      segment_id: seg.segment_id,
      status: order.status,
      payload: JSON.stringify(payload),
      events: JSON.stringify(ex.events),
      extraction: JSON.stringify({ raw: ex.raw, repaired: ex.repaired, fallback: ex.fallback, warnings }),
      build_log: JSON.stringify(state.log),
    });
    results.push({ order, payload, events: ex.events, build_log: state.log, warnings, extraction: { raw: ex.raw, repaired: ex.repaired, fallback: ex.fallback, warnings } });
    engine.log(
      `  ${seg.segment_id} -> ${order.order_id} v${version} ${order.status}${order.review.required ? ` review[${order.review.reasons.join(",")}]` : ""} (${order.items.length} items, ${order.needs_review.length} unclear, ${order.not_ordered.length} not ordered)`,
    );
    // Each order is sent the moment it is built.
    if (input.deliver) {
      const id = engine.deliverer.enqueue(payload, input.runId);
      sends.push(engine.deliverer.deliver(id));
    }
  }
  return { orders: results, sends, usage: ex.usage };
}

/** Channel roles for the payload: from a channel map when channels are separate, else one mixed channel. */
export function channelRoles(channels: number, map: Record<number, "crew" | "customer"> | null | undefined): ("customer" | "crew" | "mixed")[] {
  if (!map || channels < 2) return ["mixed"];
  return Array.from({ length: channels }, (_, i) => map[i] ?? "mixed");
}
