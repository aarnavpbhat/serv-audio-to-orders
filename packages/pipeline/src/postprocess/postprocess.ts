/**
 * Build state -> order(s). Pure. Puts every mention in exactly one bucket,
 * detects combo opportunities, sets flags and picks the status.
 */
import type { BuildState, Line, SideMention } from "../build/replay";
import { round2, type Catalog } from "../menu/catalog";
import type { FuzzyMatcher } from "../menu/fuzzy";
import type {
  Candidate,
  ComboOpportunity,
  Component,
  Flag,
  ModifierOut,
  NeedsReviewItem,
  NotOrderedItem,
  Order,
  OrderItem,
  OrderStatus,
  Size,
} from "../schemas";

export interface SegmentContext {
  segment_id: string;
  start_s: number;
  end_s: number;
  utterance_ids: string[];
  has_closing: boolean;
  truncated_start: boolean;
  truncated_end: boolean;
  non_english: boolean;
  low_audio_quality: boolean;
  crosstalk_suspected: boolean;
}

export interface PostprocessOptions {
  catalog: Catalog;
  matcher: FuzzyMatcher;
  thresholds: { recognition: number; commitment: number };
  taxRate: number;
  totalTolerance: number;
  placeholders: boolean;
  newOrderId: () => string;
  newGroupId: () => string;
}

export function postprocess(build: BuildState, seg: SegmentContext, opts: PostprocessOptions): Order[] {
  const groupId = build.split && build.parts > 1 ? opts.newGroupId() : null;
  const orders: Order[] = [];
  for (let part = 0; part < build.parts; part++) {
    orders.push(buildPart(build, part, seg, opts, groupId));
  }
  return orders;
}

function modifiersOut(catalog: Catalog, ids: string[]): ModifierOut[] {
  return ids.flatMap((id) => {
    const m = catalog.modifier(id);
    return m ? [{ id, action: m.action }] : [];
  });
}

function unitPrice(catalog: Catalog, line: Line): number {
  if (!line.catalog_id) return 0;
  if (line.components) {
    const mods = line.components.flatMap((c) => c.modifiers);
    return round2(catalog.comboPrice(line.catalog_id, line.size) + catalog.modifierPrice(mods));
  }
  return round2(catalog.itemPrice(line.catalog_id, line.size) + catalog.modifierPrice(line.modifiers));
}

function toItem(catalog: Catalog, line: Line): OrderItem {
  const id = line.catalog_id as string;
  const components: Component[] | undefined = line.components?.map((c) => ({
    slot: c.slot,
    catalog_id: c.catalog_id,
    ...(c.modifiers.length ? { modifiers: modifiersOut(catalog, c.modifiers) } : {}),
    ...(c.declined ? { declined: true } : {}),
  }));
  return {
    line_id: line.line_id,
    catalog_id: id,
    name: catalog.name(id),
    quantity: line.quantity,
    size: line.size,
    ...(components ? { components } : {}),
    modifiers: modifiersOut(catalog, line.modifiers),
    unit_price: unitPrice(catalog, line),
    recognition_confidence: round2(line.recognition_confidence),
    commitment_confidence: round2(line.commitment_confidence),
    source_utterance_ids: line.source_utterance_ids,
  };
}

function reviewCandidates(line: Line, matcher: FuzzyMatcher): Candidate[] {
  const out = new Map<string, number>();
  for (const c of line.candidates) out.set(c.catalog_id, c.score);
  if (line.catalog_id && !out.has(line.catalog_id)) out.set(line.catalog_id, round2(line.recognition_confidence));
  const query = line.raw_text ?? (line.catalog_id ? matcher.menuCatalog.name(line.catalog_id) : "");
  for (const c of matcher.candidates(query, 3)) out.set(c.catalog_id, Math.max(out.get(c.catalog_id) ?? 0, c.score));
  return [...out.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([catalog_id, score]) => ({ catalog_id, score }));
}

function sideToNotOrdered(s: SideMention): NotOrderedItem {
  return {
    catalog_id: s.catalog_id,
    ...(s.raw_text ? { raw_text: s.raw_text } : {}),
    ordered: false,
    reason: s.reason,
    ...(s.replaced_by ? { replaced_by: s.replaced_by } : {}),
    ...(s.quantity ? { quantity: s.quantity } : {}),
    ...(s.size ? { size: s.size } : {}),
    source_utterance_ids: s.source_utterance_ids,
  };
}

function lineToNotOrdered(line: Line, reason: NotOrderedItem["reason"]): NotOrderedItem {
  return {
    catalog_id: line.catalog_id,
    ...(line.raw_text ? { raw_text: line.raw_text } : {}),
    ordered: false,
    reason,
    ...(line.replaced_by ? { replaced_by: line.replaced_by } : {}),
    quantity: line.quantity,
    ...(line.size ? { size: line.size } : {}),
    line_id: line.line_id,
    source_utterance_ids: line.source_utterance_ids,
  };
}

/** Separate lines that together fill every slot of a combo. Never auto-converts. */
export function findComboOpportunities(
  catalog: Catalog,
  items: OrderItem[],
  declinedComboIds: string[],
): ComboOpportunity[] {
  const remaining = new Map<string, number>();
  for (const i of items) if (!i.components) remaining.set(i.line_id, i.quantity);
  const take = (pred: (i: OrderItem) => boolean): OrderItem | undefined => {
    const hit = items.find((i) => !i.components && (remaining.get(i.line_id) ?? 0) > 0 && pred(i));
    if (hit) remaining.set(hit.line_id, (remaining.get(hit.line_id) ?? 0) - 1);
    return hit;
  };
  const out: ComboOpportunity[] = [];
  for (const combo of catalog.menu.combos) {
    for (;;) {
      const snapshot = new Map(remaining);
      const parts: OrderItem[] = [];
      let ok = true;
      for (const slot of combo.slots) {
        const hit =
          slot.kind === "fixed"
            ? take((i) => i.catalog_id === slot.item)
            : slot.kind === "default"
              ? take((i) => slot.allowed.includes(i.catalog_id))
              : take((i) => catalog.item(i.catalog_id)?.category === slot.allowed_category);
        if (!hit) {
          ok = false;
          break;
        }
        parts.push(hit);
      }
      if (!ok) {
        remaining.clear();
        for (const [k, v] of snapshot) remaining.set(k, v);
        break;
      }
      const side = parts[1];
      const drink = parts[2];
      const size: Size = side?.size && side.size === drink?.size ? side.size : (drink?.size ?? side?.size ?? combo.default_size);
      const separate = round2(parts.reduce((s, p) => s + catalog.itemPrice(p.catalog_id, p.size), 0));
      const comboPrice = catalog.comboPrice(combo.id, size);
      const savings = round2(separate - comboPrice);
      if (savings <= 0) continue;
      out.push({
        combo_id: combo.id,
        combo_name: combo.name,
        line_ids: parts.map((p) => p.line_id),
        separate_total: separate,
        combo_price: comboPrice,
        savings,
        customer_declined_combo: declinedComboIds.includes(combo.id),
      });
    }
  }
  return out;
}

function buildPart(
  build: BuildState,
  part: number,
  seg: SegmentContext,
  opts: PostprocessOptions,
  groupId: string | null,
): Order {
  const { catalog, thresholds } = opts;
  const lines = build.lines.filter((l) => l.part === part);
  const items: OrderItem[] = [];
  const needsReview: NeedsReviewItem[] = [];
  const notOrdered: NotOrderedItem[] = [];

  for (const line of lines) {
    if (line.state === "removed") {
      notOrdered.push(lineToNotOrdered(line, line.removed_reason ?? "cancelled"));
      continue;
    }
    // An item nobody could identify goes to review even when commitment reads low: models
    // tend to mark "unsure what" as "unsure whether", and a person should look either way.
    if (line.catalog_id && line.commitment_confidence < thresholds.commitment) {
      notOrdered.push(lineToNotOrdered(line, "uncommitted"));
      continue;
    }
    if (line.catalog_id && line.recognition_confidence >= thresholds.recognition) {
      items.push(toItem(catalog, line));
      continue;
    }
    needsReview.push({
      line_id: line.line_id,
      catalog_id: line.catalog_id,
      raw_text: line.raw_text,
      quantity: line.quantity,
      size: line.size,
      candidates: reviewCandidates(line, opts.matcher),
      recognition_confidence: round2(line.recognition_confidence),
      commitment_confidence: round2(line.commitment_confidence),
      source_utterance_ids: line.source_utterance_ids,
    });
  }

  // Inquiries and declined offers only count as not_ordered if the item did not end up ordered.
  const orderedIds = new Set<string>();
  for (const i of items) {
    orderedIds.add(i.catalog_id);
    for (const c of i.components ?? []) if (c.catalog_id) orderedIds.add(c.catalog_id);
  }
  for (const r of needsReview) if (r.catalog_id) orderedIds.add(r.catalog_id);
  for (const s of build.side.filter((x) => x.part === part)) {
    if ((s.reason === "inquired" || s.reason === "declined_upsell") && s.catalog_id && orderedIds.has(s.catalog_id)) continue;
    notOrdered.push(sideToNotOrdered(s));
  }

  const declinedHere = build.side
    .filter((s) => s.part === part && s.reason === "declined_upsell" && s.catalog_id && catalog.isCombo(s.catalog_id))
    .map((s) => s.catalog_id as string);
  const comboOpps = findComboOpportunities(catalog, items, declinedHere.length ? declinedHere : build.declined_combo_ids);

  const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const computed = round2(subtotal * (1 + opts.taxRate));
  const spoken = build.spoken_totals[part] ?? null;

  const missingSlot = items.some((i) => i.components?.some((c) => c.catalog_id === null && !c.declined));
  const readbacks = build.readbacks.filter((r) => r.part === part);
  const readbackMismatch = readbacks.some((r) => r.diffs.length > 0);
  const cancelled = build.cancelled && lines.length > 0 && lines.every((l) => l.state === "removed");

  const flags = new Set<Flag>();
  if (needsReview.length) flags.add("needs_review_present");
  if (readbackMismatch) flags.add("readback_mismatch");
  if (spoken !== null && Math.abs(spoken - computed) > opts.totalTolerance && !cancelled) flags.add("total_mismatch");
  if (missingSlot) flags.add("missing_required_slot");
  if (comboOpps.length) flags.add("combo_opportunity");
  if (seg.truncated_start) flags.add("truncated_start");
  if (seg.truncated_end) flags.add("truncated_end");
  if (groupId) flags.add("split_order");
  if (seg.non_english) flags.add("non_english");
  if (seg.low_audio_quality) flags.add("low_audio_quality");
  if (seg.crosstalk_suspected) flags.add("crosstalk_suspected");
  if (opts.placeholders) flags.add("placeholder_values");

  let status: OrderStatus;
  if (cancelled) status = "cancelled";
  else if (seg.truncated_start || seg.truncated_end) status = "incomplete";
  else if (!seg.has_closing) status = "abandoned";
  else if (needsReview.length || readbackMismatch) status = "needs_review";
  else status = "completed";

  const scores = [
    ...items.map((i) => Math.min(i.recognition_confidence, i.commitment_confidence)),
    ...needsReview.map((r) => r.recognition_confidence),
  ];
  const overall = scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  return {
    order_id: opts.newOrderId(),
    group_id: groupId,
    segment_id: seg.segment_id,
    status,
    started_s: seg.start_s,
    ended_s: seg.end_s,
    items,
    needs_review: needsReview,
    not_ordered: notOrdered,
    combo_opportunities: comboOpps,
    customer_declined_combo: declinedHere.length > 0,
    flags: [...flags],
    totals: { computed, spoken_by_crew: spoken, currency: catalog.menu.currency },
    overall_confidence: overall,
    readback_diffs: readbacks.flatMap((r) => r.diffs),
    utterance_ids: seg.utterance_ids,
  };
}
