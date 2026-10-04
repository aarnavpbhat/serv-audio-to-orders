import { z } from "zod";
import {
  ComboOpportunity,
  Flag,
  NeedsReviewItem,
  NotOrderedItem,
  OrderItem,
  OrderStatus,
  Totals,
} from "./order";
import { TimestampSource } from "./transcript";

export const WebhookEventType = z.enum([
  "order.completed",
  "order.cancelled",
  "order.abandoned",
  "order.needs_review",
  "order.incomplete",
  "order.updated",
]);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const PayloadUtterance = z.object({
  id: z.string(),
  speaker: z.enum(["crew", "customer"]),
  start_utc: z.string(),
  end_utc: z.string(),
  text: z.string(),
  confidence: z.number(),
  non_customer: z.boolean().optional(),
});

/** Webhook payload, schema v1.0. */
export const OrderPayload = z.object({
  schema_version: z.literal("1.0"),
  event_type: WebhookEventType,
  order_id: z.string(),
  order_version: z.number().int().positive(),
  group_id: z.string().nullable(),
  location_id: z.string(),
  lane_id: z.string(),
  status: OrderStatus,
  started_at: z.string(),
  ended_at: z.string(),
  timestamp_source: TimestampSource,
  audio: z.object({ source_file: z.string(), offset_start_s: z.number(), offset_end_s: z.number() }),
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
