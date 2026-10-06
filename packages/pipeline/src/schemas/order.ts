import { z } from "zod";
import { Candidate } from "./events";
import { ModifierAction, Size } from "./menu";

/**
 * How the ordering conversation ended, set only from evidence (plan D2, D10).
 * Whether a person should check the order is the separate `review` block.
 */
export const OrderStatus = z.enum(["completed", "cancelled", "abandoned", "undetermined"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const FLAGS = [
  "readback_mismatch",
  "total_mismatch",
  "missing_required_slot",
  "combo_opportunity",
  "truncated_start",
  "truncated_end",
  "split_order",
  "non_english",
  "low_audio_quality",
  "crosstalk_suspected",
  "placeholder_values",
  /** The stream dropped mid-conversation and came back within the grace window. */
  "stream_gap",
  /** The stream dropped mid-conversation and did not come back in time. */
  "stream_interrupted",
  /** Transcription lost audio (provider error or reconnect) during the conversation. */
  "transcript_gap",
  /** The per-lane buffer overflowed and the oldest audio was dropped. */
  "audio_dropped",
  /** Disk guard paused raw capture and audio archiving; the order itself is unaffected. */
  "capture_paused",
  /** The lane sent audio faster than its declared format allows. */
  "audio_rate_exceeded",
  /** A car arrived and left and nobody spoke (decision E1). */
  "no_speech",
  /** An operator ended the session while this conversation was open (E3). */
  "ended_by_operator",
] as const;
export const Flag = z.enum(FLAGS);
export type Flag = z.infer<typeof Flag>;

export const REVIEW_REASONS = [
  "unclear_items",
  "readback_mismatch",
  "total_mismatch",
  "missing_required_slot",
  "low_audio_quality",
  "stream_gap",
  "transcript_gap",
  "outcome_undetermined",
  "roles_guessed_low_agreement",
  /** Plan D13: a quantity above the cap or a total above the cap; model output is never trusted blindly. */
  "safety_cap",
] as const;
export const ReviewReason = z.enum(REVIEW_REASONS);
export type ReviewReason = z.infer<typeof ReviewReason>;

export const Review = z.object({ required: z.boolean(), reasons: z.array(ReviewReason) });
export type Review = z.infer<typeof Review>;

/**
 * Why the status is what it is. Silence and stream events may appear only as
 * context_only: they never establish completed or abandoned on their own.
 */
export const OutcomeEvidence = z.object({
  type: z.enum(["spoken_cue", "vehicle_event", "stream_event", "silence", "order_state", "human_review"]),
  /** spoken_cue: what kind of cue it was. */
  kind: z.enum(["closing", "customer_done", "departure_said", "cancel", "next_car_greeting"]).optional(),
  /** spoken_cue: the phrase that matched. */
  cue: z.string().optional(),
  /** vehicle_event, stream_event or order_state: the event name. */
  event: z.string().optional(),
  utterance_id: z.string().optional(),
  at: z.string(),
  duration_s: z.number().optional(),
  context_only: z.boolean().optional(),
});
export type OutcomeEvidence = z.infer<typeof OutcomeEvidence>;

export const NotOrderedReason = z.enum([
  "cancelled",
  "replaced",
  "declined_upsell",
  "out_of_stock",
  "inquired",
  "uncommitted",
]);
export type NotOrderedReason = z.infer<typeof NotOrderedReason>;

export const ModifierOut = z.object({ id: z.string(), action: ModifierAction });
export type ModifierOut = z.infer<typeof ModifierOut>;

export const Component = z.object({
  slot: z.string(),
  catalog_id: z.string().nullable(),
  modifiers: z.array(ModifierOut).optional(),
  declined: z.boolean().optional(),
});
export type Component = z.infer<typeof Component>;

export const OrderItem = z.object({
  line_id: z.string(),
  catalog_id: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  size: Size.nullable(),
  components: z.array(Component).optional(),
  modifiers: z.array(ModifierOut),
  unit_price: z.number(),
  recognition_confidence: z.number(),
  commitment_confidence: z.number(),
  source_utterance_ids: z.array(z.string()),
});
export type OrderItem = z.infer<typeof OrderItem>;

export const NeedsReviewItem = z.object({
  line_id: z.string(),
  catalog_id: z.string().nullable(),
  raw_text: z.string().nullable(),
  quantity: z.number().int().positive(),
  size: Size.nullable(),
  candidates: z.array(Candidate),
  recognition_confidence: z.number(),
  commitment_confidence: z.number(),
  source_utterance_ids: z.array(z.string()),
});
export type NeedsReviewItem = z.infer<typeof NeedsReviewItem>;

export const NotOrderedItem = z.object({
  catalog_id: z.string().nullable(),
  raw_text: z.string().nullable().optional(),
  ordered: z.literal(false),
  reason: NotOrderedReason,
  replaced_by: z.string().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  size: Size.nullable().optional(),
  line_id: z.string().optional(),
  source_utterance_ids: z.array(z.string()),
});
export type NotOrderedItem = z.infer<typeof NotOrderedItem>;

export const ComboOpportunity = z.object({
  combo_id: z.string(),
  combo_name: z.string(),
  line_ids: z.array(z.string()),
  separate_total: z.number(),
  combo_price: z.number(),
  savings: z.number(),
  customer_declined_combo: z.boolean(),
});
export type ComboOpportunity = z.infer<typeof ComboOpportunity>;

export const Totals = z.object({
  computed: z.number(),
  spoken_by_crew: z.number().nullable(),
  currency: z.string(),
});

/** An order as produced by post-processing, before the webhook envelope is added. */
export const Order = z.object({
  order_id: z.string(),
  group_id: z.string().nullable(),
  segment_id: z.string(),
  status: OrderStatus,
  outcome_evidence: z.array(OutcomeEvidence),
  review: Review,
  started_s: z.number(),
  ended_s: z.number(),
  items: z.array(OrderItem),
  needs_review: z.array(NeedsReviewItem),
  not_ordered: z.array(NotOrderedItem),
  combo_opportunities: z.array(ComboOpportunity),
  customer_declined_combo: z.boolean(),
  flags: z.array(Flag),
  totals: Totals,
  overall_confidence: z.number(),
  readback_diffs: z.array(z.string()),
  utterance_ids: z.array(z.string()),
});
export type Order = z.infer<typeof Order>;
