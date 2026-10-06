/**
 * The review screen's back end (plan step 11): a person resolves an order that
 * needs review by picking a candidate for each unclear item (or dropping it)
 * and confirming or changing the outcome. That makes the next version
 * (correction_reason human_review, order.updated), stored and sent like any
 * other version, and a label recording what the person decided.
 */
import { z } from "zod";
import type { Engine } from "../engine";
import { putLabel } from "../data/labels";
import { OrderPayload, OrderStatus, type OrderItem } from "../schemas";
import { insertOrder, latestOrder } from "../store/db";
import { correctedPayload } from "../webhook/corrections";

export const ReviewResolution = z.object({
  /** The version the person was looking at; a newer one means someone (or a late event) changed it first. */
  version: z.number().int().positive(),
  /** One choice per unclear item, by line_id: a catalog id, or null to drop it. */
  items: z.record(z.string().max(64), z.string().max(64).nullable()).default({}),
  status: OrderStatus,
  author: z.string().min(1).max(100),
  note: z.string().max(2000).optional(),
});
export type ReviewResolution = z.input<typeof ReviewResolution>;

export class ReviewConflictError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An unclear item resolved to a catalog id: priced and shaped like an extracted item, with full confidence. */
function resolvedItem(engine: Engine, line: OrderPayload["needs_review"][number], catalogId: string): OrderItem {
  const { catalog } = engine;
  if (!catalog.has(catalogId)) throw new Error(`Unknown catalog id ${catalogId}`);
  const combo = catalog.combo(catalogId);
  const size = catalog.sizeFor(catalogId, line.size);
  // A combo gets its fixed and default slots; a slot the customer must choose stays open (missing_required_slot).
  const components = combo?.slots.map((s) => ({ slot: s.slot, catalog_id: s.kind === "required" ? null : s.item }));
  return {
    line_id: line.line_id,
    catalog_id: catalogId,
    name: catalog.name(catalogId),
    quantity: line.quantity,
    size,
    ...(components ? { components } : {}),
    modifiers: [],
    unit_price: round2(combo ? catalog.comboPrice(catalogId, size) : catalog.itemPrice(catalogId, size)),
    recognition_confidence: 1,
    commitment_confidence: 1,
    source_utterance_ids: line.source_utterance_ids,
  };
}

export async function resolveReview(engine: Engine, orderId: string, raw: ReviewResolution, opts: { deliver?: boolean; now?: () => number } = {}): Promise<OrderPayload> {
  const input = ReviewResolution.parse(raw);
  const row = latestOrder(engine.db, orderId);
  if (!row) throw new Error(`No order ${orderId}`);
  if (row.version !== input.version) throw new ReviewConflictError(`Order ${orderId} is at version ${row.version} now; reload before resolving`);
  const prev = OrderPayload.parse(JSON.parse(row.payload));
  const at = new Date((opts.now ?? Date.now)()).toISOString();

  const items = [...prev.items];
  const needsReview: OrderPayload["needs_review"] = [];
  const notOrdered = [...prev.not_ordered];
  for (const line of prev.needs_review) {
    if (!Object.hasOwn(input.items, line.line_id)) {
      needsReview.push(line);
      continue;
    }
    const choice = input.items[line.line_id];
    if (choice) items.push(resolvedItem(engine, line, choice));
    else notOrdered.push({ catalog_id: line.catalog_id, raw_text: line.raw_text, ordered: false, reason: "uncommitted", quantity: line.quantity, size: line.size, line_id: line.line_id, source_utterance_ids: line.source_utterance_ids });
  }

  const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const computed = round2(subtotal * (1 + engine.cfg.taxRate.value));
  const spoken = prev.totals.spoken_by_crew;
  const flags = new Set(prev.flags);
  // Totals and slots are re-checked against the resolved items; the rest describes the audio and stays.
  flags.delete("total_mismatch");
  if (spoken !== null && Math.abs(spoken - computed) > engine.cfg.totalTolerance && input.status !== "cancelled") flags.add("total_mismatch");
  if (items.some((i) => i.components?.some((c) => c.catalog_id === null && !c.declined))) flags.add("missing_required_slot");
  else flags.delete("missing_required_slot");

  const unresolved = needsReview.length > 0;
  const next = correctedPayload(
    prev,
    {
      status: input.status,
      items,
      needs_review: needsReview,
      not_ordered: notOrdered,
      flags: [...flags],
      totals: { ...prev.totals, computed },
      outcome_evidence: [...prev.outcome_evidence, { type: "human_review", event: input.status === prev.status ? "status_confirmed" : `status_changed_from_${prev.status}`, at }],
      // A person has looked at it: review is done unless some unclear items were left open.
      review: unresolved ? { required: true, reasons: ["unclear_items"] } : { required: false, reasons: [] },
    },
    "human_review",
    at,
  );

  insertOrder(engine.db, {
    order_id: orderId,
    version: next.order_version,
    run_id: row.run_id,
    segment_id: row.segment_id,
    status: next.status,
    payload: JSON.stringify(next),
    events: row.events,
    extraction: row.extraction,
    build_log: row.build_log,
  });
  await putLabel(engine.db, engine.data, orderId, {
    order_version: prev.order_version,
    verdict: "incorrect",
    corrected: { status: input.status, items: input.items, resolved_version: next.order_version },
    author: input.author,
    ...(input.note ? { note: input.note } : {}),
  });
  if (opts.deliver !== false) {
    const id = engine.deliverer.enqueue(next, row.run_id);
    void engine.deliverer.deliver(id);
  }
  engine.log(`${orderId} v${next.order_version}: review resolved by ${input.author} (${next.status})`);
  return next;
}
