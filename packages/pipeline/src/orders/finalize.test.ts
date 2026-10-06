/** Shared conversation finalization: versions per order id. */
import { describe, expect, it } from "vitest";
import { emptyUsage } from "../extract/types";
import type { Segment, Transcript } from "../schemas";
import { events, testEngine } from "../test-helpers";
import { finalizeConversation } from "./finalize";

const BASE = "2026-10-03T18:40:00.000Z";
const at = (s: number) => new Date(Date.parse(BASE) + s * 1000).toISOString();
const utt = (id: string, speaker: "crew" | "customer", text: string, s: number) => ({ id, speaker, text, start_s: s, end_s: s + 2, start_utc: at(s), end_utc: at(s + 2), confidence: 1, words: [] });
const transcript: Transcript = {
  transcript_id: "tr",
  source_file: "x",
  audio: { codec: "pcm_s16le", sample_rate: 16000, channels: 1, duration_s: 30 },
  audio_start_utc: BASE,
  timestamp_source: "receive_clock",
  role_source: "script",
  stt: "test",
  language: null,
  utterances: [utt("u1", "customer", "Separate checks. A hamburger.", 0), utt("u2", "customer", "And for the second, fries.", 4), utt("u3", "crew", "Pull forward please.", 8)],
};
const segment = { segment_id: "seg_1", index: 0, start_s: 0, end_s: 10, utterance_ids: ["u1", "u2", "u3"], non_customer_ids: [], has_greeting: false, has_closing: true, truncated_start: false, truncated_end: false, trailing_silence_s: 0, language: null, non_english: false, mean_word_conf: 1, crosstalk_suspected: false } satisfies Segment;
const session = { sessionId: "ses_1", storeId: "s", laneId: "l", timeBasis: "receive_clock" as const, sessionOffsetS: 0, source: { type: "hme_ws" as const, codecIn: "pcm_s16le", channels: 1, channelRoles: ["mixed" as const] } };

describe("finalizeConversation", () => {
  it("a split part first seen on a reopen starts at version 1; the existing order goes to version 2", async () => {
    const engine = testEngine();
    engine.extractor = {
      name: "stub",
      extract: async () => ({
        events: events([
          { event_id: "e1", type: "SPLIT_ORDER", source_utterance_ids: ["u1"] },
          { event_id: "e2", type: "ADD", catalog_id: "hamburger", source_utterance_ids: ["u1"] },
          { event_id: "e3", type: "READBACK", amount: 2.49, source_utterance_ids: ["u1"] },
          { event_id: "e4", type: "ADD", catalog_id: "fries", source_utterance_ids: ["u2"] },
        ]),
        usage: emptyUsage("none"),
        warnings: [],
        raw: null,
        repaired: false,
        fallback: false,
      }),
    };
    const done = await finalizeConversation(engine, { runId: "run_v", segment, transcript, session, receivedAt: at(0), orderIds: ["ord_A"], version: new Map([["ord_A", 1]]), correctionReason: "reopened_late_addition", deliver: false });
    expect(done.orders.map((o) => [o.payload.order_id === "ord_A", o.payload.order_version, o.payload.event_type, o.payload.correction_reason])).toEqual([
      [true, 2, "order.updated", "reopened_late_addition"],
      [false, 1, "order.finalized", null],
    ]);
  });
});
