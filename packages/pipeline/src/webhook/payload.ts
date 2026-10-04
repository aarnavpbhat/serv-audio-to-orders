import { addSeconds } from "../ingest/start-time";
import { OrderPayload, type Order, type Transcript, type WebhookEventType } from "../schemas";

export interface PayloadContext {
  transcript: Transcript;
  locationId: string;
  laneId: string;
  stt: string;
  extractor: string;
  menuVersion: string;
  pipelineVersion: string;
  latencyMs: number;
  nonCustomerIds: Set<string>;
  orderVersion?: number;
  eventType?: WebhookEventType;
}

export function toPayload(order: Order, ctx: PayloadContext): OrderPayload {
  const ids = new Set(order.utterance_ids);
  const transcript = ctx.transcript.utterances
    .filter((u) => ids.has(u.id))
    .map((u) => ({
      id: u.id,
      speaker: u.speaker,
      start_utc: u.start_utc,
      end_utc: u.end_utc,
      text: u.text,
      confidence: u.confidence,
      ...(ctx.nonCustomerIds.has(u.id) ? { non_customer: true } : {}),
    }));
  return OrderPayload.parse({
    schema_version: "1.0",
    event_type: ctx.eventType ?? `order.${order.status}`,
    order_id: order.order_id,
    order_version: ctx.orderVersion ?? 1,
    group_id: order.group_id,
    location_id: ctx.locationId,
    lane_id: ctx.laneId,
    status: order.status,
    started_at: addSeconds(ctx.transcript.audio_start_utc, order.started_s),
    ended_at: addSeconds(ctx.transcript.audio_start_utc, order.ended_s),
    timestamp_source: ctx.transcript.timestamp_source,
    audio: { source_file: ctx.transcript.source_file, offset_start_s: order.started_s, offset_end_s: order.ended_s },
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
