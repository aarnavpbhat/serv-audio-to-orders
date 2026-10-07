/**
 * Ground truth for a run whose answer is known (decision E6): fixture audio has a
 * timeline next to it naming, for each conversation, the script and order it
 * came from. Scoring matches each expected conversation span to the produced
 * segment it overlaps most, then compares orders, exactly as the eval does
 * (the eval uses these functions), so the run page and the eval never disagree.
 */
import path from "node:path";
import { loadFixtureScripts } from "../fixtures/load";
import type { Catalog } from "../menu/catalog";
import type { ExpectedOrder, FixtureTimeline, Order, OrderPayload, Segment } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import { compareOrders, passed, type CompareOptions, type OrderComparison } from "./compare";

export interface Span {
  start_s: number;
  end_s: number;
}

export interface GroundTruth {
  /** Expected orders with the conversation span (index into spans) each belongs to. */
  expected: { span: number; order: ExpectedOrder }[];
  spans: Span[];
  timeline: FixtureTimeline;
}

/** One conversation span's expected orders against what was produced, paired in order. */
export interface TruthRow {
  span: Span | null;
  segmentId: string | null;
  expected: ExpectedOrder | null;
  actual: OrderPayload | null;
  comparison: OrderComparison & { pass: boolean };
}

/** Distinct conversation spans in a timeline (split-payment orders share one). */
export function spansOf(timeline: FixtureTimeline): Span[] {
  return [...new Map(timeline.orders.map((o) => [`${o.start_s}-${o.end_s}`, { start_s: o.start_s, end_s: o.end_s }])).values()];
}

/**
 * The known answer for a fixture audio file, or null when there is none (an
 * upload, a phone recording, a live session): only files inside the fixtures
 * folder with a timeline whose scripts all exist count.
 */
export function groundTruthFor(fixturesDir: string, file: string | null | undefined): GroundTruth | null {
  if (!file) return null;
  const rel = path.relative(path.resolve(fixturesDir), path.resolve(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const timeline = loadTimeline(file);
  if (!timeline?.orders.length) return null;
  const scripts = new Map(loadFixtureScripts(path.join(fixturesDir, "scripts")).map((s) => [s.id, s]));
  const spans = spansOf(timeline);
  const expected: GroundTruth["expected"] = [];
  for (const o of timeline.orders) {
    const order = scripts.get(o.fixture_id)?.expected.orders[o.order_index];
    if (!order) return null;
    expected.push({ span: spans.findIndex((s) => s.start_s === o.start_s && s.end_s === o.end_s), order });
  }
  return { expected, spans, timeline };
}

/** Each expected span -> the unused produced segment it overlaps most (or undefined). */
export function matchSpans(spans: Span[], segments: Pick<Segment, "segment_id" | "start_s" | "end_s">[]): (Pick<Segment, "segment_id" | "start_s" | "end_s"> | undefined)[] {
  const used = new Set<string>();
  return spans.map((sp) => {
    let best: Pick<Segment, "segment_id" | "start_s" | "end_s"> | undefined;
    let bestOverlap = 0;
    for (const s of segments) {
      if (used.has(s.segment_id)) continue;
      const ov = Math.min(sp.end_s, s.end_s) - Math.max(sp.start_s, s.start_s);
      if (ov > bestOverlap) [best, bestOverlap] = [s, ov];
    }
    if (best) used.add(best.segment_id);
    return best;
  });
}

const EXTRA_CHECKS: OrderComparison["checks"] = { items: false, needs_review: true, not_ordered: true, flags: true, status: true, review: true, group: true, declined_combo: true };

/**
 * Expected against produced, per span: matched orders, expected orders with
 * nothing produced, and produced orders nobody expected (extra in a span, or
 * from a segment that matches no span).
 */
export function scoreOrders(
  catalog: Catalog,
  truth: Pick<GroundTruth, "expected" | "spans">,
  segments: Pick<Segment, "segment_id" | "start_s" | "end_s">[],
  produced: { order: Order; payload: OrderPayload }[],
  opts: CompareOptions = {},
): { rows: TruthRow[]; matchFor: ReturnType<typeof matchSpans>; countsOk: boolean } {
  const matchFor = matchSpans(truth.spans, segments);
  const rows: TruthRow[] = [];
  let countsOk = true;
  truth.spans.forEach((span, k) => {
    const exp = truth.expected.filter((e) => e.span === k).map((e) => e.order);
    const seg = matchFor[k];
    const mine = seg ? produced.filter((o) => o.order.segment_id === seg.segment_id) : [];
    if (mine.length !== exp.length) countsOk = false;
    const comparisons = compareOrders(
      catalog,
      exp,
      mine.map((o) => ({ ...o.order, version: o.payload.order_version })),
      opts,
    );
    comparisons.forEach((c, i) => rows.push({ span, segmentId: seg?.segment_id ?? null, expected: exp[i] ?? null, actual: mine[i]?.payload ?? null, comparison: { ...c, pass: passed(c) } }));
    for (const extra of mine.slice(exp.length)) {
      rows.push({
        span,
        segmentId: seg?.segment_id ?? null,
        expected: null,
        actual: extra.payload,
        comparison: { checks: EXTRA_CHECKS, item_tp: 0, item_fp: extra.order.items.length, item_fn: 0, bucket_correct: 0, bucket_total: 0, diffs: [`unexpected extra order ${extra.order.order_id}`], pass: false },
      });
    }
  });
  const used = new Set(matchFor.filter((s) => s).map((s) => s?.segment_id));
  for (const s of segments.filter((x) => !used.has(x.segment_id))) {
    for (const o of produced.filter((x) => x.order.segment_id === s.segment_id)) {
      rows.push({
        span: null,
        segmentId: s.segment_id,
        expected: null,
        actual: o.payload,
        comparison: { checks: EXTRA_CHECKS, item_tp: 0, item_fp: o.order.items.length, item_fn: 0, bucket_correct: 0, bucket_total: 0, diffs: [`extra segment ${s.segment_id} produced ${o.order.order_id}`], pass: false },
      });
    }
  }
  return { rows, matchFor, countsOk };
}
