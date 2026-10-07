/**
 * Synthetic vehicle events for fixture timelines: each car arrives just before
 * its conversation and leaves just after it ends. An abandoned car leaves
 * without a close; a recording cut off mid-order has no departure.
 */
import type { FixtureScript, FixtureTimeline } from "../schemas";

export type VehicleEvent = FixtureTimeline["vehicle_events"][number];

const ARRIVE_BEFORE_S = 1.5;
const DEPART_AFTER_S = 2;
const ABANDON_AFTER_S = 1;

export function deriveVehicleEvents(t: Pick<FixtureTimeline, "orders" | "duration_s">, scripts: Map<string, FixtureScript>): VehicleEvent[] {
  // Split payments share one span: one car per distinct span.
  const spans = [...new Map(t.orders.map((o) => [`${o.start_s}-${o.end_s}`, o])).values()];
  const out: VehicleEvent[] = [];
  spans.forEach((sp, i) => {
    const next = spans[i + 1];
    const expected = scripts.get(sp.fixture_id)?.expected.orders[sp.order_index];
    const status = expected?.status_with_vehicle_events ?? expected?.status;
    // A conversation already under way when the recording starts has no arrival to report.
    if (sp.start_s >= 0.5) out.push({ type: "vehicle_arrived", at_s: round(Math.max(0, sp.start_s - ARRIVE_BEFORE_S)) });
    const cutOff = status === "undetermined" && t.duration_s - sp.end_s < 1;
    if (cutOff) return;
    const after = status === "abandoned" ? ABANDON_AFTER_S : DEPART_AFTER_S;
    let at = sp.end_s + after;
    if (next) at = Math.min(at, next.start_s - ARRIVE_BEFORE_S - 0.1);
    at = Math.min(at, t.duration_s);
    if (at >= sp.end_s) out.push({ type: "vehicle_departed", at_s: round(at) });
  });
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
