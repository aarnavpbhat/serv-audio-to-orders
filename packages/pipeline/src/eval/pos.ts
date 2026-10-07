/**
 * Eval Layer B, "rung up": does our order match the POS ticket? (Layer A,
 * "heard", checks the order against what was said.)
 *
 * PLACEHOLDER ticket schema until Serv shares real POS data:
 *   { store_id, lane_id, ticket_id, opened_at, closed_at, items: [{ catalog_id, quantity, size }] }
 *
 * The sandbox builds synthetic tickets from each fixture's expected orders,
 * opened 10 s into the conversation, and applies fixtures/pos/window-changes.json
 * (what the crew rang differently at the window). Real tickets replace both later.
 *
 * Matcher: same store and lane, ticket opened within ±90 s of the conversation
 * start; among those, the most items in common, then the closest in time. Each
 * difference is categorized:
 *   extraction_error  we got the item wrong (Layer A is wrong there too)
 *   window_change     we heard it right; it was rung up differently
 *   unmatched         a ticket with no order, or a completed order with no ticket
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Catalog } from "../menu/catalog";
import type { ExpectedOrder, OrderPayload } from "../schemas";

export const PosItem = z.object({ catalog_id: z.string(), quantity: z.number().int().positive(), size: z.enum(["small", "medium", "large"]).nullable() });
export const PosTicket = z.object({
  store_id: z.string(),
  lane_id: z.string(),
  ticket_id: z.string(),
  opened_at: z.string(),
  closed_at: z.string(),
  items: z.array(PosItem),
});
export type PosTicket = z.infer<typeof PosTicket>;

export const WindowChange = z.object({
  fixture: z.string(),
  order: z.number().int().nonnegative().default(0),
  replace: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  add: z.array(PosItem).default([]),
  remove: z.array(z.string()).default([]),
  note: z.string(),
});
export type WindowChange = z.infer<typeof WindowChange>;

export const POS_WINDOW_S = 90;
const OPEN_AFTER_S = 10;

export type DiffCategory = "extraction_error" | "window_change" | "unmatched";

export interface LayerBMatch {
  order_id: string | null;
  ticket_id: string | null;
  exact: boolean;
  diffs: { item: string; category: DiffCategory }[];
}

export function loadWindowChanges(fixturesDir: string): WindowChange[] {
  const file = path.join(fixturesDir, "pos", "window-changes.json");
  return existsSync(file) ? z.array(WindowChange).parse(JSON.parse(readFileSync(file, "utf8"))) : [];
}

/** Ticket line key: what a POS rings up (item, size, quantity). */
const key = (catalog: Catalog, i: { catalog_id: string; quantity: number; size?: string | null }) => `${i.catalog_id}|${i.size === undefined ? (catalog.sizeFor(i.catalog_id, null) ?? "-") : (i.size ?? "-")}|x${i.quantity}`;

/** The ticket a completed expected order would have produced, with any window change applied. */
export function syntheticTicket(
  catalog: Catalog,
  o: { fixture: string; index: number; order: ExpectedOrder; start: string; end: string; storeId: string; laneId: string },
  changes: WindowChange[],
): PosTicket | null {
  if (o.order.status !== "completed" && o.order.status_with_vehicle_events !== "completed") return null;
  let items = o.order.items.map((i) => ({ catalog_id: i.catalog_id, quantity: i.quantity, size: i.size === undefined ? catalog.sizeFor(i.catalog_id, null) : i.size }));
  for (const c of changes.filter((x) => x.fixture === o.fixture && x.order === o.index)) {
    items = items.filter((i) => !c.remove.includes(i.catalog_id)).map((i) => {
      const r = c.replace.find((x) => x.from === i.catalog_id);
      return r ? { ...i, catalog_id: r.to } : i;
    });
    items.push(...c.add);
  }
  const opened = new Date(Date.parse(o.start) + OPEN_AFTER_S * 1000).toISOString();
  return { store_id: o.storeId, lane_id: o.laneId, ticket_id: `pos_${o.fixture}_${o.index}`, opened_at: opened, closed_at: o.end, items };
}

function multiset(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/**
 * Match orders to tickets and categorize every difference. `expectedFor`
 * gives the hand-checked order behind a ticket (Layer A truth), so a
 * difference can be blamed on us or on the window.
 */
export function matchLayerB(catalog: Catalog, orders: OrderPayload[], tickets: PosTicket[], expectedFor: (ticketId: string) => ExpectedOrder | undefined, windowS = POS_WINDOW_S): LayerBMatch[] {
  // Candidate pairs: same store and lane, opened within the window. Split payments ring two
  // tickets at once and back-to-back cars are close together, so pairs are taken by item
  // overlap first and time second, across all orders at once.
  const keysOf = (items: { catalog_id: string; quantity: number; size?: string | null }[]) => multiset(items.map((i) => key(catalog, i)));
  const pairs: { o: OrderPayload; t: PosTicket; overlap: number; dt: number }[] = [];
  for (const o of orders) {
    const ours = keysOf(o.items);
    for (const t of tickets) {
      const dt = Math.abs(Date.parse(t.opened_at) - Date.parse(o.times.started_at));
      if (t.store_id !== o.store_id || t.lane_id !== o.lane_id || dt > windowS * 1000) continue;
      const rung = keysOf(t.items);
      let overlap = 0;
      for (const [k, n] of ours) overlap += Math.min(n, rung.get(k) ?? 0);
      pairs.push({ o, t, overlap, dt });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || a.dt - b.dt);
  const orderDone = new Set<string>();
  const ticketDone = new Set<string>();
  const out: LayerBMatch[] = [];
  for (const { o, t } of pairs) {
    if (orderDone.has(o.order_id) || ticketDone.has(t.ticket_id)) continue;
    orderDone.add(o.order_id);
    ticketDone.add(t.ticket_id);
    const ours = keysOf(o.items);
    const rung = keysOf(t.items);
    const heard = keysOf(expectedFor(t.ticket_id)?.items ?? []);
    const diffs: LayerBMatch["diffs"] = [];
    for (const k of new Set([...ours.keys(), ...rung.keys()])) {
      if ((ours.get(k) ?? 0) === (rung.get(k) ?? 0)) continue;
      // We match what was said but the ticket does not: the window changed it.
      const category: DiffCategory = (ours.get(k) ?? 0) === (heard.get(k) ?? 0) ? "window_change" : "extraction_error";
      diffs.push({ item: k, category });
    }
    out.push({ order_id: o.order_id, ticket_id: t.ticket_id, exact: diffs.length === 0, diffs });
  }
  // Only an order that was rung up should have a ticket.
  for (const o of orders) if (!orderDone.has(o.order_id) && o.status === "completed" && o.items.length) out.push({ order_id: o.order_id, ticket_id: null, exact: false, diffs: [{ item: "(whole order)", category: "unmatched" }] });
  for (const t of tickets) if (!ticketDone.has(t.ticket_id)) out.push({ order_id: null, ticket_id: t.ticket_id, exact: false, diffs: [{ item: "(whole ticket)", category: "unmatched" }] });
  return out;
}
