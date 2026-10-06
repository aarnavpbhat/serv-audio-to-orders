import type { OrderPayload } from "../schemas";

/** A minimal valid v2.0 payload, for the webhook self-check and tests. */
export function samplePayload(orderId = "ord_selfcheck", version = 1): OrderPayload {
  return {
    schema_version: "2.0",
    event_type: version === 1 ? "order.finalized" : "order.updated",
    order_id: orderId,
    order_version: version,
    supersedes_version: version > 1 ? version - 1 : null,
    correction_reason: version > 1 ? "reopened_late_addition" : null,
    group_id: null,
    store_id: "store_demo_001",
    lane_id: "lane_1",
    session_id: "ses_selfcheck",
    status: "completed",
    outcome_evidence: [{ type: "spoken_cue", kind: "closing", cue: "pull forward", utterance_id: "u4", at: "2026-10-03T18:42:24.100Z" }],
    review: { required: false, reasons: [] },
    times: {
      started_at: "2026-10-03T18:41:01.200Z",
      ended_at: "2026-10-03T18:42:24.880Z",
      time_basis: "recording_metadata",
      received_at: "2026-10-03T18:41:01.350Z",
      finalized_at: "2026-10-03T18:42:28.010Z",
    },
    audio_ref: { session_id: "ses_selfcheck", sample_start: 0, sample_end: 16000, archive_uri: null },
    source: { type: "file_replay", codec_in: "mp3", channels: 1, channel_roles: ["mixed"] },
    items: [],
    needs_review: [],
    not_ordered: [],
    combo_opportunities: [],
    customer_declined_combo: false,
    flags: [],
    totals: { computed: 0, spoken_by_crew: null, currency: "USD" },
    overall_confidence: 1,
    transcript: [],
    processing: { stt: "selfcheck", extractor: "selfcheck", menu_version: "sandbox-1", pipeline_version: "0.1.0", latency_ms: 0 },
  };
}
