/** Layer B: matching orders to POS tickets and blaming each difference. */
import { describe, expect, it } from "vitest";
import type { ExpectedOrder, OrderPayload } from "../schemas";
import { samplePayload } from "../webhook/sample";
import { catalog } from "../test-helpers";
import { matchLayerB, syntheticTicket, type PosTicket } from "./pos";

const T0 = "2026-10-03T18:40:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
type Sz = "small" | "medium" | "large" | null;
const expected = (items: [string, Sz][]): ExpectedOrder => ({ status: "completed", items: items.map(([catalog_id, size]) => ({ catalog_id, quantity: 1, size })), needs_review: [], not_ordered: [], flags: [], review: [], group: null }) as unknown as ExpectedOrder;
function order(id: string, startS: number, items: [string, Sz][]): OrderPayload {
  const p = samplePayload();
  const item = (catalog_id: string, size: Sz, i: number) => ({ line_id: `L${i}`, catalog_id, name: catalog_id, quantity: 1, size, modifiers: [], unit_price: 1, recognition_confidence: 1, commitment_confidence: 1, source_utterance_ids: [] });
  return { ...p, order_id: id, store_id: "s", lane_id: "l", status: "completed", times: { ...p.times, started_at: at(startS) }, items: items.map(([c, size], i) => item(c, size, i)) };
}
const ticket = (id: string, e: ExpectedOrder, startS: number, changes = []) => syntheticTicket(catalog, { fixture: id, index: 0, order: e, start: at(startS), end: at(startS + 30), storeId: "s", laneId: "l" }, changes) as PosTicket;

describe("Layer B matcher", () => {
  it("an exact order matches; a window change is blamed on the window; our mistake is an extraction error", () => {
    const heard = expected([["dbl_cheese", null], ["fries", "medium"]]);
    const changed = syntheticTicket(catalog, { fixture: "f", index: 0, order: heard, start: at(0), end: at(30), storeId: "s", laneId: "l" }, [{ fixture: "f", order: 0, replace: [{ from: "fries", to: "onion_rings" }], add: [], remove: [], note: "" }]) as PosTicket;
    const right = matchLayerB(catalog, [order("o1", 0, [["dbl_cheese", null], ["fries", "medium"]])], [changed], () => heard);
    expect(right[0]?.diffs.map((d) => d.category)).toEqual(["window_change", "window_change"]);
    const wrong = matchLayerB(catalog, [order("o1", 0, [["dbl_cheese", null], ["fries", "large"]])], [ticket("f", heard, 0)], () => heard);
    expect(wrong[0]?.diffs.map((d) => [d.item, d.category])).toEqual([
      ["fries|large|x1", "extraction_error"],
      ["fries|medium|x1", "extraction_error"],
    ]);
  });

  it("split payment: two tickets at the same moment pair by items, not by order of arrival", () => {
    const a = expected([["hamburger", null]]);
    const b = expected([["crispy_chicken", null]]);
    const tickets = [ticket("a", a, 0), { ...ticket("b", b, 0), ticket_id: "pos_b_0" }];
    const m = matchLayerB(catalog, [order("o2", 1, [["crispy_chicken", null]]), order("o1", 0, [["hamburger", null]])], tickets, (id) => (id.includes("_a_") ? a : b));
    expect(m.every((x) => x.exact)).toBe(true);
  });

  it("outside the window, another lane, or nothing rung up: unmatched; non-completed orders need no ticket", () => {
    const e = expected([["hamburger", null]]);
    const far = matchLayerB(catalog, [order("o1", 0, [["hamburger", null]])], [ticket("f", e, 200)], () => e);
    expect(far.map((x) => x.diffs[0]?.category)).toEqual(["unmatched", "unmatched"]);
    const cancelled = { ...order("o1", 0, []), status: "cancelled" as const };
    expect(matchLayerB(catalog, [cancelled], [], () => undefined)).toEqual([]);
    expect(syntheticTicket(catalog, { fixture: "x", index: 0, order: { ...e, status: "abandoned" }, start: at(0), end: at(1), storeId: "s", laneId: "l" }, [])).toBeNull();
  });
});
