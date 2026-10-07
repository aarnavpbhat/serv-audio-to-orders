/** Compares produced orders with a fixture's expected block. Used by unit tests and `pnpm eval`. */
import type { Catalog } from "../menu/catalog";
import type { ExpectedItem, ExpectedOrder, Order, OrderItem } from "../schemas";

export interface OrderComparison {
  checks: {
    items: boolean;
    needs_review: boolean;
    not_ordered: boolean;
    flags: boolean;
    status: boolean;
    review: boolean;
    group: boolean;
    declined_combo: boolean;
  };
  item_tp: number;
  item_fp: number;
  item_fn: number;
  bucket_correct: number;
  bucket_total: number;
  diffs: string[];
}

const IGNORED_FLAGS = new Set(["placeholder_values"]);

function sortedJoin(xs: string[]): string {
  return [...xs].sort().join(",");
}

export function expectedItemKey(catalog: Catalog, e: ExpectedItem): string {
  const size = e.size === undefined ? catalog.sizeFor(e.catalog_id, null) : e.size;
  const comps = e.components ? sortedJoin(e.components.map((c) => `${c.slot}:${c.catalog_id ?? "-"}`)) : "";
  return `${e.catalog_id}|x${e.quantity}|${size ?? "-"}|${sortedJoin(e.modifiers ?? [])}|${comps}`;
}

export function actualItemKey(i: OrderItem, withComponents: boolean): string {
  const mods = [...i.modifiers.map((m) => m.id), ...(i.components ?? []).flatMap((c) => (c.modifiers ?? []).map((m) => m.id))];
  const comps = withComponents && i.components ? sortedJoin(i.components.map((c) => `${c.slot}:${c.catalog_id ?? "-"}`)) : "";
  return `${i.catalog_id}|x${i.quantity}|${i.size ?? "-"}|${sortedJoin(mods)}|${comps}`;
}

function multisetDiff(expected: string[], actual: string[]): { tp: number; missing: string[]; extra: string[] } {
  const pool = [...actual];
  const missing: string[] = [];
  let tp = 0;
  for (const e of expected) {
    const idx = pool.indexOf(e);
    if (idx >= 0) {
      pool.splice(idx, 1);
      tp++;
    } else missing.push(e);
  }
  return { tp, missing, extra: pool };
}

export interface CompareOptions {
  /** The run went through the live path: check lane_version when the fixture sets it. */
  lane?: boolean;
  /**
   * Vehicle events in the run: off (audio only), on (the true timeline, so
   * `status_with_vehicle_events` applies), or noisy (some missed: either status is fine).
   */
  vehicleEvents?: "off" | "on" | "noisy";
}

export const expectedStatus = (exp: ExpectedOrder, opts: CompareOptions = {}) =>
  (opts.vehicleEvents === "on" ? exp.status_with_vehicle_events : undefined) ?? exp.status;

export function compareOrder(catalog: Catalog, exp: ExpectedOrder, act: (Order & { version?: number }) | undefined, opts: CompareOptions = {}): OrderComparison {
  const diffs: string[] = [];
  if (!act) {
    const n = exp.items.length;
    return {
      checks: { items: false, needs_review: false, not_ordered: false, flags: false, status: false, review: false, group: false, declined_combo: false },
      item_tp: 0,
      item_fp: 0,
      item_fn: n,
      bucket_correct: 0,
      bucket_total: n + exp.needs_review.length + exp.not_ordered.length,
      diffs: ["order missing"],
    };
  }

  const expKeys = exp.items.map((e) => expectedItemKey(catalog, e));
  const actKeys = act.items.map((i) => {
    const e = exp.items.find((x) => x.catalog_id === i.catalog_id);
    return actualItemKey(i, !!e?.components);
  });
  const items = multisetDiff(expKeys, actKeys);
  for (const m of items.missing) diffs.push(`missing item ${m}`);
  for (const x of items.extra) diffs.push(`extra item ${x}`);

  let nrOk = exp.needs_review.length === act.needs_review.length;
  if (!nrOk) diffs.push(`needs_review: expected ${exp.needs_review.length}, got ${act.needs_review.length}`);
  exp.needs_review.forEach((e, i) => {
    const a = act.needs_review[i];
    if (!a) return;
    if (e.candidates_include.length && !a.candidates.some((c) => e.candidates_include.includes(c.catalog_id))) {
      nrOk = false;
      diffs.push(`needs_review[${i}] candidates ${a.candidates.map((c) => c.catalog_id).join("/")} miss ${e.candidates_include.join("/")}`);
    }
  });

  const no = multisetDiff(
    exp.not_ordered.map((n) => `${n.catalog_id ?? "?"}:${n.reason}`),
    act.not_ordered.map((n) => `${n.catalog_id ?? "?"}:${n.reason}`),
  );
  for (const m of no.missing) diffs.push(`missing not_ordered ${m}`);
  for (const x of no.extra) diffs.push(`extra not_ordered ${x}`);

  const expFlags = sortedJoin(exp.flags.filter((f) => !IGNORED_FLAGS.has(f)));
  const actFlags = sortedJoin(act.flags.filter((f) => !IGNORED_FLAGS.has(f)));
  if (expFlags !== actFlags) diffs.push(`flags: expected [${expFlags}], got [${actFlags}]`);
  const noisyAlt = opts.vehicleEvents === "noisy" && exp.status_with_vehicle_events === act.status;
  const status = noisyAlt ? act.status : expectedStatus(exp, opts);
  if (status !== act.status) diffs.push(`status: expected ${status}, got ${act.status}`);
  const expReview = sortedJoin(exp.review);
  const actReview = sortedJoin(act.review.reasons);
  if (expReview !== actReview) diffs.push(`review: expected [${expReview}], got [${actReview}]`);

  const versionOk = !opts.lane || exp.lane_version === undefined || exp.lane_version === act.version;
  if (!versionOk) diffs.push(`order_version: expected ${exp.lane_version}, got ${act.version ?? 1}`);
  const declinedOk = exp.customer_declined_combo === undefined || exp.customer_declined_combo === act.customer_declined_combo;
  if (!declinedOk) diffs.push(`customer_declined_combo: expected ${exp.customer_declined_combo}`);

  const bucketTotal = exp.items.length + exp.needs_review.length + exp.not_ordered.length;
  const bucketCorrect = items.tp + Math.min(exp.needs_review.length, act.needs_review.length) + no.tp;

  return {
    checks: {
      items: items.missing.length === 0 && items.extra.length === 0,
      needs_review: nrOk,
      not_ordered: no.missing.length === 0 && no.extra.length === 0,
      flags: expFlags === actFlags,
      status: status === act.status,
      review: expReview === actReview,
      group: true,
      declined_combo: declinedOk && versionOk,
    },
    item_tp: items.tp,
    item_fp: items.extra.length,
    item_fn: items.missing.length,
    bucket_correct: bucketCorrect,
    bucket_total: bucketTotal,
    diffs,
  };
}

/** Compares a list of expected orders with produced orders, in time order, including group checks. */
export function compareOrders(catalog: Catalog, expected: ExpectedOrder[], actual: (Order & { version?: number })[], opts: CompareOptions = {}): OrderComparison[] {
  const results = expected.map((e, i) => compareOrder(catalog, e, actual[i], opts));
  // Group labels: same label -> same non-null group_id; null label -> null group_id.
  expected.forEach((e, i) => {
    const a = actual[i];
    const r = results[i];
    if (!a || !r) return;
    let ok: boolean;
    if (e.group === null) ok = a.group_id === null;
    else {
      const peers = expected.map((x, j) => (x.group === e.group ? actual[j]?.group_id : undefined)).filter((g) => g !== undefined);
      ok = a.group_id !== null && peers.every((g) => g === a.group_id);
    }
    if (!ok) {
      r.checks.group = false;
      r.diffs.push(`group: expected ${e.group ?? "none"}, got ${a.group_id ?? "none"}`);
    }
  });
  return results;
}

export function passed(c: OrderComparison): boolean {
  return Object.values(c.checks).every(Boolean);
}
