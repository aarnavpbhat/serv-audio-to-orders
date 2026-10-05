import { describe, expect, it } from "vitest";
import { replay } from "../build/replay";
import { compareOrder } from "../eval/compare";
import { postprocess } from "../postprocess/postprocess";
import { ExpectedOrder } from "../schemas";
import { catalog, events, matcher, ppOptions, seg } from "../test-helpers";

const build = (list: Parameters<typeof events>[0]) => replay(events(list), catalog);
const order = (list: Parameters<typeof events>[0], ctx = seg()) => postprocess(build(list), ctx, ppOptions())[0]!;

describe("replay", () => {
  it("an unidentified item goes to needs_review even with low commitment", () => {
    const o = order([{ event_id: "e1", type: "ADD", catalog_id: null, raw_text: "flourblberry shake", recognition_confidence: 0.1, commitment_confidence: 0.2 }]);
    expect(o.needs_review).toHaveLength(1);
    expect(o.not_ordered).toHaveLength(0);
  });

  it("removing a hesitated item keeps it uncommitted, not cancelled", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "cookie", commitment_confidence: 0.2 },
      { event_id: "e2", type: "REMOVE", target_line_ref: "e1" },
    ]);
    expect(s.lines[0]?.removed_reason).toBe("uncommitted");
  });

  it("REMOVE after OUT_OF_STOCK does not add a second not-ordered entry", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "shake_choc" },
      { event_id: "e2", type: "OUT_OF_STOCK", target_line_ref: "e1", catalog_id: "shake_choc" },
      { event_id: "e3", type: "REMOVE", target_line_ref: "e1", catalog_id: "shake_choc" },
    ]);
    expect(s.lines[0]?.removed_reason).toBe("out_of_stock");
    expect(s.side.filter((m) => m.reason === "cancelled")).toHaveLength(0);
  });

  it("split asked before ordering: each spoken total closes one order", () => {
    const s = build([
      { event_id: "e1", type: "SPLIT_ORDER" },
      { event_id: "e2", type: "ADD", catalog_id: "combo_5" },
      { event_id: "e3", type: "READBACK", amount: 8.99 },
      { event_id: "e4", type: "ADD", catalog_id: "nuggets_6" },
      { event_id: "e5", type: "READBACK", amount: 6.58 },
    ]);
    expect(s.lines.map((l) => l.part)).toEqual([0, 1]);
  });

  it("follows replacement chains when later events reference the original line", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "coke", size: "small" },
      { event_id: "e2", type: "REPLACE", target_line_ref: "e1", catalog_id: "sprite" },
      { event_id: "e3", type: "CHANGE_SIZE", target_line_ref: "e1", size: "large" },
    ]);
    const active = s.lines.filter((l) => l.state === "active");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ catalog_id: "sprite", size: "large" });
  });

  it("REPLACE carries size and applicable modifiers to the new item", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "cheeseburger", modifiers: ["no_pickles"] },
      { event_id: "e2", type: "REPLACE", target_line_ref: "e1", catalog_id: "dbl_cheese" },
    ]);
    expect(s.lines.find((l) => l.line_id === "e2")?.modifiers).toEqual(["no_pickles"]);
  });

  it("slot-level REPLACE on a combo records the old drink as replaced only if the customer chose it", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "combo_2" },
      { event_id: "e2", type: "SET_COMBO_SLOT", target_line_ref: "e1", slot: "drink", catalog_id: "coke" },
      { event_id: "e3", type: "REPLACE", target_line_ref: "e1", catalog_id: "sprite" },
      { event_id: "e4", type: "SET_COMBO_SLOT", target_line_ref: "e1", slot: "side", catalog_id: "onion_rings" },
    ]);
    const combo = s.lines[0]!;
    expect(combo.components?.find((c) => c.slot === "drink")?.catalog_id).toBe("sprite");
    expect(combo.components?.find((c) => c.slot === "side")?.catalog_id).toBe("onion_rings");
    // Coke was chosen then replaced; default fries were never said, so not a mention.
    expect(s.side.map((x) => [x.catalog_id, x.reason])).toEqual([["coke", "replaced"]]);
  });

  it("combo modifiers land on the component they apply to", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "combo_2", modifiers: ["no_pickles"] },
      { event_id: "e2", type: "SET_COMBO_SLOT", target_line_ref: "e1", catalog_id: "coke", modifiers: ["no_ice"] },
    ]);
    const comps = s.lines[0]!.components!;
    expect(comps.find((c) => c.slot === "entree")?.modifiers).toEqual(["no_pickles"]);
    expect(comps.find((c) => c.slot === "drink")?.modifiers).toEqual(["no_ice"]);
  });

  it("SET_COMBO_SLOT without a ref fills the most recent combo that accepts the item", () => {
    const s = build([
      { event_id: "e1", type: "ADD", catalog_id: "combo_1" },
      { event_id: "e2", type: "ADD", catalog_id: "cookie" },
      { event_id: "e3", type: "SET_COMBO_SLOT", catalog_id: "dr_pepper" },
    ]);
    expect(s.lines[0]!.components?.find((c) => c.slot === "drink")?.catalog_id).toBe("dr_pepper");
  });

  it("partial REMOVE keeps the rest of the line", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "cheeseburger", quantity: 3 },
      { event_id: "e2", type: "REMOVE", target_line_ref: "e1", quantity: 1 },
    ]);
    expect(o.items[0]?.quantity).toBe(2);
    expect(o.not_ordered).toMatchObject([{ catalog_id: "cheeseburger", reason: "cancelled", quantity: 1 }]);
  });

  it("an ADD after CANCEL_ORDER reopens the order", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "fries" },
      { event_id: "e2", type: "CANCEL_ORDER" },
      { event_id: "e3", type: "ADD", catalog_id: "apple_pie" },
    ]);
    expect(o.status).toBe("completed");
    expect(o.items.map((i) => i.catalog_id)).toEqual(["apple_pie"]);
    expect(o.not_ordered.map((n) => n.reason)).toEqual(["cancelled"]);
  });

  it("SPLIT_ORDER with a boundary line moves that line and later ones to a second order", () => {
    const orders = postprocess(
      build([
        { event_id: "e1", type: "ADD", catalog_id: "hamburger" },
        { event_id: "e2", type: "ADD", catalog_id: "fries" },
        { event_id: "e3", type: "ADD", catalog_id: "cookie" },
        { event_id: "e4", type: "SPLIT_ORDER", target_line_ref: "e2" },
      ]),
      seg(),
      ppOptions(),
    );
    expect(orders.map((o) => o.items.map((i) => i.catalog_id))).toEqual([["hamburger"], ["fries", "cookie"]]);
    expect(orders[0]!.group_id).not.toBeNull();
    expect(orders[0]!.group_id).toBe(orders[1]!.group_id);
  });

  it("an inquiry about something later ordered is not reported as not_ordered", () => {
    const o = order([
      { event_id: "e1", type: "INQUIRE", catalog_id: "apple_pie" },
      { event_id: "e2", type: "ADD", catalog_id: "apple_pie" },
    ]);
    expect(o.not_ordered).toEqual([]);
  });

  it("unknown catalog ids become needs_review with fuzzy candidates", () => {
    const o = order([{ event_id: "e1", type: "ADD", catalog_id: "fluffy_thing", raw_text: "sandy fluffy" }]);
    expect(o.items).toEqual([]);
    expect(o.needs_review[0]?.candidates[0]?.catalog_id).toBe("fluffle");
    expect(o.status).toBe("needs_review");
  });

  it("readback with a different quantity is flagged", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "nuggets_6", quantity: 2 },
      { event_id: "e2", type: "READBACK", readback_items: [{ catalog_id: "nuggets_6", quantity: 3 }] },
    ]);
    expect(o.flags).toContain("readback_mismatch");
    expect(o.readback_diffs[0]).toMatch(/quantity 3/);
  });
});

describe("post-processing", () => {
  it("combo opportunity reports the exact savings and does not convert", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "dbl_cheese" },
      { event_id: "e2", type: "ADD", catalog_id: "fries", size: "medium" },
      { event_id: "e3", type: "ADD", catalog_id: "coke", size: "medium" },
    ]);
    expect(o.items).toHaveLength(3);
    expect(o.combo_opportunities).toEqual([
      expect.objectContaining({ combo_id: "combo_2", separate_total: 10.27, combo_price: 9.49, savings: 0.78 }),
    ]);
  });

  it("free water makes no combo opportunity when the meal costs more", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "big_sandbox" },
      { event_id: "e2", type: "ADD", catalog_id: "fries", size: "large" },
      { event_id: "e3", type: "ADD", catalog_id: "water", size: "large" },
    ]);
    expect(o.combo_opportunities).toEqual([]);
  });

  it("an explicit 'no drink' answer suppresses missing_required_slot", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "combo_4" },
      { event_id: "e2", type: "SET_COMBO_SLOT", target_line_ref: "e1", slot: "drink", catalog_id: null, raw_text: "no drink" },
    ]);
    expect(o.flags).not.toContain("missing_required_slot");
  });

  it("status precedence: cancelled > incomplete > abandoned > needs_review > completed", () => {
    const base = [{ event_id: "e1", type: "ADD" as const, catalog_id: "fries", recognition_confidence: 0.5 }];
    expect(order(base, seg({ truncated_end: true, has_closing: false })).status).toBe("incomplete");
    expect(order(base, seg({ has_closing: false })).status).toBe("abandoned");
    expect(order(base).status).toBe("needs_review");
    expect(order([...base, { event_id: "e2", type: "CANCEL_ORDER" }], seg({ has_closing: false })).status).toBe("cancelled");
  });

  it("thresholds route lines to items, needs_review or not_ordered", () => {
    const o = order([
      { event_id: "e1", type: "ADD", catalog_id: "fries", recognition_confidence: 0.9, commitment_confidence: 0.9 },
      { event_id: "e2", type: "ADD", catalog_id: "coke", recognition_confidence: 0.5, commitment_confidence: 0.9 },
      { event_id: "e3", type: "ADD", catalog_id: "cookie", recognition_confidence: 0.9, commitment_confidence: 0.5 },
    ]);
    expect(o.items.map((i) => i.catalog_id)).toEqual(["fries"]);
    expect(o.needs_review.map((i) => i.catalog_id)).toEqual(["coke"]);
    expect(o.not_ordered.map((i) => [i.catalog_id, i.reason])).toEqual([["cookie", "uncommitted"]]);
  });

  it("the comparator catches wrong size, missing flags and wrong status", () => {
    const o = order([{ event_id: "e1", type: "ADD", catalog_id: "fries", size: "small" }]);
    const exp = ExpectedOrder.parse({ status: "abandoned", items: [{ catalog_id: "fries", size: "large" }], flags: ["combo_opportunity"] });
    const r = compareOrder(catalog, exp, o);
    expect(r.checks).toMatchObject({ items: false, flags: false, status: false });
    expect(r.item_fp).toBe(1);
    expect(r.item_fn).toBe(1);
  });

  it("fuzzy matcher maps misheard names", () => {
    expect(matcher.match("sandy fluffel")?.catalog_id).toBe("fluffle");
    expect(matcher.match("big sand box")?.catalog_id).toBe("big_sandbox");
    expect(matcher.match("doctor pepper")?.catalog_id).toBe("dr_pepper");
  });
});
