import { z } from "zod";
import {
  ComboOpportunity,
  Flag,
  NeedsReviewItem,
  NotOrderedItem,
  OrderItem,
  OrderStatus,
  OutcomeEvidence,
  Review,
  Totals,
} from "./order";

/** Plan D3: version 1 is order.finalized, later versions are order.updated. The status lives in the body. */
export const WebhookEventType = z.enum(["order.finalized", "order.updated"]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const CorrectionReason = z.enum(["reopened_late_addition", "late_evidence", "human_review"]);
export type CorrectionReason = z.infer<typeof CorrectionReason>;

/** Where recording time came from: a timestamp in the feed, our receive time, or file metadata (replay). */
export const TimeBasis = z.enum(["source_clock", "receive_clock", "recording_metadata"]);
export type TimeBasis = z.infer<typeof TimeBasis>;

export const SourceType = z.enum(["hme_ws", "file_replay", "rtsp"]);
export type SourceType = z.infer<typeof SourceType>;

export const ChannelRole = z.enum(["customer", "crew", "mixed"]);
export type ChannelRole = z.infer<typeof ChannelRole>;

export const PayloadUtterance = z.object({
  id: z.string(),
  speaker: z.enum(["crew", "customer"]),
  /** Role inferred from wording because the audio did not separate the voices. */
  speaker_guessed: z.boolean().optional(),
  start_utc: z.string(),
  end_utc: z.string(),
  text: z.string(),
  confidence: z.number(),
  non_customer: z.boolean().optional(),
});

export const PayloadTimes = z.object({
  /** Recording time the conversation started and ended (when it was spoken, not when we processed it). */
  started_at: z.string(),
  ended_at: z.string(),
  time_basis: TimeBasis,
  /** Processing times: first audio of the conversation arrived, and when we decided it had ended. */
  received_at: z.string(),
  finalized_at: z.string(),
});
export type PayloadTimes = z.infer<typeof PayloadTimes>;

export const AudioRef = z.object({
  session_id: z.string(),
  /** Samples per channel at 16 kHz since the session anchor. */
  sample_start: z.number().int().nonnegative(),
  sample_end: z.number().int().nonnegative(),
  /** Archived audio for this order version, when archiving is on. */
  archive_uri: z.string().nullable(),
});
export type AudioRef = z.infer<typeof AudioRef>;

export const PayloadSource = z.object({
  type: SourceType,
  codec_in: z.string(),
  channels: z.number().int().positive(),
  channel_roles: z.array(ChannelRole),
});
export type PayloadSource = z.infer<typeof PayloadSource>;

/** Webhook payload, schema v2.0. */
export const OrderPayload = z.object({
  schema_version: z.literal("2.0"),
  event_type: WebhookEventType,
  order_id: z.string(),
  order_version: z.number().int().positive(),
  supersedes_version: z.number().int().positive().nullable(),
  correction_reason: CorrectionReason.nullable(),
  group_id: z.string().nullable(),
  store_id: z.string(),
  lane_id: z.string(),
  session_id: z.string(),
  status: OrderStatus,
  outcome_evidence: z.array(OutcomeEvidence),
  review: Review,
  times: PayloadTimes,
  audio_ref: AudioRef,
  source: PayloadSource,
  items: z.array(OrderItem),
  needs_review: z.array(NeedsReviewItem),
  not_ordered: z.array(NotOrderedItem),
  combo_opportunities: z.array(ComboOpportunity),
  customer_declined_combo: z.boolean(),
  flags: z.array(Flag),
  totals: Totals,
  overall_confidence: z.number(),
  transcript: z.array(PayloadUtterance),
  processing: z.object({
    stt: z.string(),
    extractor: z.string(),
    menu_version: z.string(),
    pipeline_version: z.string(),
    latency_ms: z.number(),
  }),
});
export type OrderPayload = z.infer<typeof OrderPayload>;
