import { describe, expect, it } from "vitest";
import { applyRows, deliveryFor, remainingMs, type LiveRow } from "./live";

let id = 0;
const row = (type: string, data: Record<string, unknown>, lane = "lane_1"): LiveRow => ({ id: ++id, at: id, store_id: "s1", lane_id: lane, type, data: { type, ...data } });
const utt = (uid: string, text: string) => ({ utterance: { id: uid, speaker: "customer", text, start_utc: "2026-10-05T18:00:00Z", end_utc: "2026-10-05T18:00:02Z" } });
const order = (v: number, status: string) => ({ payload: { order_id: "ord_1", order_version: v, status } });

describe("live lane state", () => {
  it("keeps lanes apart and tracks the connection", () => {
    const lanes = applyRows({}, [row("session", { sessionId: "ses_1", open: true, at: "2026-10-05T18:00:00Z", codec: "mulaw" }), row("session", { sessionId: "ses_2", open: true, at: "2026-10-05T18:00:00Z" }, "lane_2")]);
    expect(Object.keys(lanes).sort()).toEqual(["s1:lane_1", "s1:lane_2"]);
    expect(lanes["s1:lane_1"]?.session?.codec).toBe("mulaw");
    const closed = applyRows(lanes, [row("interim", { text: "a cheese" }), row("session", { sessionId: "ses_1", open: false, at: "2026-10-05T18:01:00Z" })]);
    expect(closed["s1:lane_1"]?.connected).toBe(false);
    expect(closed["s1:lane_1"]?.interim).toBeNull();
    expect(closed["s1:lane_2"]?.connected).toBe(true);
  });

  it("a final line replaces the interim text", () => {
    const lanes = applyRows({}, [row("interim", { text: "a cheese" }), row("utterance", utt("u1", "A cheeseburger"))]);
    expect(lanes["s1:lane_1"]?.interim).toBeNull();
    expect(lanes["s1:lane_1"]?.utterances.map((u) => u.text)).toEqual(["A cheeseburger"]);
  });

  it("keeps the highest version of each order, newest first", () => {
    const lanes = applyRows({}, [row("order", order(2, "completed")), row("order", order(1, "undetermined"))]);
    expect(lanes["s1:lane_1"]?.orders.map((o) => [o.order_version, o.status])).toEqual([[2, "completed"]]);
  });

  it("matches deliveries to order versions", () => {
    const lanes = applyRows({}, [row("delivery", { webhookId: "ord_1_v1", orderId: "ord_1", version: 1, status: "delivered", attempts: 1, code: 200 })]);
    const lane = lanes["s1:lane_1"];
    expect(lane && deliveryFor(lane, "ord_1", 1)?.status).toBe("delivered");
    expect(lane && deliveryFor(lane, "ord_1", 2)).toBeUndefined();
  });

  it("timers count down on the wall clock from when the status arrived", () => {
    const lanes = applyRows({}, [row("status", { status: { state: "CLOSING", conversationId: "conv_1", timers: { settle: "2026-10-05T18:00:03Z" } }, clock: "2026-10-05T18:00:00Z", audioMinutes: 0.5 })], 1000);
    const lane = lanes["s1:lane_1"];
    expect(lane && remainingMs(lane, lane.status?.timers.settle, 2000)).toBe(2000);
    expect(lane?.audioMinutes).toBe(0.5);
  });
});
