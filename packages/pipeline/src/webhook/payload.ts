import { addSeconds } from "../ingest/start-time";
import {
  OrderPayload,
  type ChannelRole,
  type CorrectionReason,
  type Order,
  type SourceType,
  type TimeBasis,
  type Transcript,
} from "../schemas";

/** Samples per second of canonical audio; audio_ref offsets count these. */
export const CANONICAL_RATE = 16_000;

export interface PayloadContext {
  /** Utterances of this conversation; their times are recording time. */
  transcript: Transcript;
  storeId: string;
  laneId: string;
  sessionId: string;
  timeBasis: TimeBasis;
  /** Seconds from the session anchor to the transcript's audio_start_utc (0 for file replays). */
  sessionOffsetS?: number;
  receivedAt: string;
  finalizedAt: string;
  archiveUri?: string | null;
  source: { type: SourceType; codecIn: string; channels: number; channelRoles: ChannelRole[] };
  stt: string;
  extractor: string;
  menuVersion: string;
  pipelineVersion: string;
  latencyMs: number;
  nonCustomerIds: Set<string>;
  orderVersion?: number;
  correctionReason?: CorrectionReason | null;
}

/** The formatting step only: every decision (status, review, buckets) was made in postprocess. */
export function toPayload(order: Order, ctx: PayloadContext): OrderPayload {
  const ids = new Set(order.utterance_ids);
  const transcript = ctx.transcript.utterances
    .filter((u) => ids.has(u.id))
    .map((u) => ({
      id: u.id,
      speaker: u.speaker,
      ...(u.speaker_guessed ? { speaker_guessed: true } : {}),
      start_utc: u.start_utc,
      end_utc: u.end_utc,
      text: u.text,
      confidence: u.confidence,
      ...(ctx.nonCustomerIds.has(u.id) ? { non_customer: true } : {}),
    }));
  const version = ctx.orderVersion ?? 1;
  const offset = ctx.sessionOffsetS ?? 0;
  return OrderPayload.parse({
    schema_version: "2.0",
    event_type: version === 1 ? "order.finalized" : "order.updated",
    order_id: order.order_id,
    order_version: version,
    supersedes_version: version > 1 ? version - 1 : null,
    correction_reason: version > 1 ? (ctx.correctionReason ?? null) : null,
    group_id: order.group_id,
    store_id: ctx.storeId,
    lane_id: ctx.laneId,
    session_id: ctx.sessionId,
    status: order.status,
    outcome_evidence: order.outcome_evidence,
    review: order.review,
    times: {
      started_at: addSeconds(ctx.transcript.audio_start_utc, order.started_s),
      ended_at: addSeconds(ctx.transcript.audio_start_utc, order.ended_s),
      time_basis: ctx.timeBasis,
      received_at: ctx.receivedAt,
      finalized_at: ctx.finalizedAt,
    },
    audio_ref: {
      session_id: ctx.sessionId,
      sample_start: Math.max(0, Math.round((offset + order.started_s) * CANONICAL_RATE)),
      sample_end: Math.max(0, Math.round((offset + order.ended_s) * CANONICAL_RATE)),
      archive_uri: ctx.archiveUri ?? null,
    },
    source: { type: ctx.source.type, codec_in: ctx.source.codecIn, channels: ctx.source.channels, channel_roles: ctx.source.channelRoles },
    items: order.items,
    needs_review: order.needs_review,
    not_ordered: order.not_ordered,
    combo_opportunities: order.combo_opportunities,
    customer_declined_combo: order.customer_declined_combo,
    flags: order.flags,
    totals: order.totals,
    overall_confidence: order.overall_confidence,
    transcript,
    processing: {
      stt: ctx.stt,
      extractor: ctx.extractor,
      menu_version: ctx.menuVersion,
      pipeline_version: ctx.pipelineVersion,
      latency_ms: ctx.latencyMs,
    },
  });
}

/** webhook-id is constant across retries of the same order version (receivers dedupe on it). */
export const webhookId = (orderId: string, version: number) => `${orderId}_v${version}`;
