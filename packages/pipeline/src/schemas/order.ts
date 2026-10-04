import { z } from "zod";
import { Candidate } from "./events";
import { ModifierAction, Size } from "./menu";

export const OrderStatus = z.enum(["completed", "cancelled", "abandoned", "needs_review", "incomplete"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const FLAGS = [
  "needs_review_present",
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
] as const;
export const Flag = z.enum(FLAGS);
export type Flag = z.infer<typeof Flag>;

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
