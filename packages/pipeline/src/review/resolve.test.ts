/** Review screen back end: resolving an order makes the next version (human_review) and a label. */
import { describe, expect, it } from "vitest";
import { listLabels } from "../data/labels";
import { emptyUsage } from "../extract/types";
import { finalizeConversation } from "../orders/finalize";
import type { Segment, Transcript } from "../schemas";
import { outboxForOrder } from "../store/db";
import { events, testEngine } from "../test-helpers";
import { resolveReview, ReviewConflictError } from "./resolve";

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
  utterances: [utt("u1", "customer", "A cheeseburger and a medium flurbleberry shake.", 0), utt("u2", "crew", "Pull forward please.", 4)],
};
const segment = { segment_id: "seg_1", index: 0, start_s: 0, end_s: 6, utterance_ids: ["u1", "u2"], non_customer_ids: [], has_greeting: false, has_closing: true, truncated_start: false, truncated_end: false, trailing_silence_s: 0, language: null, non_english: false, mean_word_conf: 1, crosstalk_suspected: false } satisfies Segment;
const session = { sessionId: "ses_1", storeId: "s", laneId: "l", timeBasis: "receive_clock" as const, sessionOffsetS: 0, source: { type: "hme_ws" as const, codecIn: "pcm_s16le", channels: 1, channelRoles: ["mixed" as const] } };

async function orderNeedingReview() {
  const engine = testEngine();
  engine.extractor = {
    name: "stub",
    extract: async () => ({
      events: events([
        { event_id: "e1", type: "ADD", catalog_id: "cheeseburger", source_utterance_ids: ["u1"] },
        { event_id: "e2", type: "ADD", catalog_id: null, raw_text: "flurbleberry shake", size: "medium", recognition_confidence: 0.3, candidates: [{ catalog_id: "shake_straw", score: 0.41 }, { catalog_id: "shake_choc", score: 0.38 }], source_utterance_ids: ["u1"] },
      ]),
      usage: emptyUsage("none"),
      warnings: [],
      raw: null,
      repaired: false,
      fallback: false,
    }),
  };
  const done = await finalizeConversation(engine, { runId: "run_r", segment, transcript, session, receivedAt: at(0), deliver: false });
  const p = done.orders[0]?.payload;
  if (!p) throw new Error("no order");
  return { engine, p };
}

describe("resolveReview", () => {
  it("picks a candidate for the unclear item and confirms the outcome: v2, human_review, review cleared, priced, labelled, queued", async () => {
    const { engine, p } = await orderNeedingReview();
    expect(p.review.required).toBe(true);
    const line = p.needs_review[0]?.line_id ?? "";
    const next = await resolveReview(engine, p.order_id, { version: 1, items: { [line]: "shake_choc" }, status: "completed", author: "tester" }, { deliver: false });
    expect([next.order_version, next.event_type, next.correction_reason, next.supersedes_version]).toEqual([2, "order.updated", "human_review", 1]);
    expect(next.items.map((i) => [i.catalog_id, i.size, i.unit_price])).toEqual([
      ["cheeseburger", null, 2.99],
      ["shake_choc", "medium", 3.99],
    ]);
    expect(next.needs_review).toEqual([]);
    expect(next.review).toEqual({ required: false, reasons: [] });
    expect(next.totals.computed).toBe(6.98);
    expect(next.outcome_evidence.at(-1)).toMatchObject({ type: "human_review", event: "status_confirmed" });
    expect((await listLabels(engine.data, p.order_id)).map((l) => [l.author, l.order_version])).toEqual([["tester", 1]]);
  });

  it("dropping an item moves it to not ordered; changing the status is recorded; it is sent", async () => {
    const { engine, p } = await orderNeedingReview();
    const line = p.needs_review[0]?.line_id ?? "";
    const next = await resolveReview(engine, p.order_id, { version: 1, items: { [line]: null }, status: "cancelled", author: "tester" });
    expect(next.items.map((i) => i.catalog_id)).toEqual(["cheeseburger"]);
    expect(next.not_ordered.map((n) => [n.raw_text, n.reason])).toEqual([["flurbleberry shake", "uncommitted"]]);
    expect(next.outcome_evidence.at(-1)?.event).toBe(`status_changed_from_${p.status}`);
    expect(outboxForOrder(engine.db, p.order_id).map((o) => o.order_version)).toContain(2);
  });

  it("refuses a stale version and an unknown catalog id; leaving an item open keeps the review", async () => {
    const { engine, p } = await orderNeedingReview();
    const line = p.needs_review[0]?.line_id ?? "";
    await expect(resolveReview(engine, p.order_id, { version: 7, items: {}, status: "completed", author: "t" }, { deliver: false })).rejects.toBeInstanceOf(ReviewConflictError);
    await expect(resolveReview(engine, p.order_id, { version: 1, items: { [line]: "not_a_thing" }, status: "completed", author: "t" }, { deliver: false })).rejects.toThrow(/Unknown catalog id/);
    const next = await resolveReview(engine, p.order_id, { version: 1, items: {}, status: "completed", author: "t" }, { deliver: false });
    expect(next.review).toEqual({ required: true, reasons: ["unclear_items"] });
  });
});
