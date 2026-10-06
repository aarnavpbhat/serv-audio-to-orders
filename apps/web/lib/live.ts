/**
 * Live view state: the live_events feed (lane updates from `pnpm feed serve`
 * or a replay) folded into one state per store and lane. Pure, so the browser
 * and the tests share it.
 */
import type { DraftLine, OrderPayload, TrackerDecision } from "@serv/pipeline";

export interface LiveUtterance {
  id: string;
  speaker: "crew" | "customer";
  speaker_guessed?: boolean;
  text: string;
  start_utc: string;
  end_utc: string;
}

export type LiveOrder = Omit<OrderPayload, "transcript">;

export interface LiveDelivery {
  webhookId: string;
  orderId: string;
  version: number;
  status: string;
  attempts: number;
  code: number | null;
}

export interface TrackerStatus {
  state: "IDLE" | "ACTIVE" | "CLOSING" | "FINALIZED";
  conversationId: string | null;
  timers: Record<string, string | null>;
}

export interface LaneState {
  key: string;
  storeId: string;
  laneId: string;
  connected: boolean;
  session: { id: string; codec?: string; channels?: number; sourceType?: string; since: string } | null;
  utterances: LiveUtterance[];
  interim: string | null;
  status: TrackerStatus | null;
  /** Lane clock when the status was sent, and when it arrived here (wall ms): timers count down from there. */
  statusClock: string | null;
  statusAt: number;
  audioMinutes: number;
  decisions: TrackerDecision[];
  draft: { conversationId: string | null; lines: DraftLine[] };
  /** Latest version of each order, newest first. */
  orders: LiveOrder[];
  deliveries: Record<string, LiveDelivery>;
  events: { event: string; at: string }[];
  lastAt: number;
}

export interface LiveRow {
  id: number;
  at: number;
  store_id: string;
  lane_id: string;
  type: string;
  data: Record<string, unknown>;
}

const KEEP_UTTERANCES = 400;
const KEEP_DECISIONS = 120;
const KEEP_EVENTS = 60;

export function emptyLane(storeId: string, laneId: string): LaneState {
  return {
    key: `${storeId}:${laneId}`,
    storeId,
    laneId,
    connected: false,
    session: null,
    utterances: [],
    interim: null,
    status: null,
    statusClock: null,
    statusAt: 0,
    audioMinutes: 0,
    decisions: [],
    draft: { conversationId: null, lines: [] },
    orders: [],
    deliveries: {},
    events: [],
    lastAt: 0,
  };
}

const tail = <T,>(xs: T[], n: number) => (xs.length > n ? xs.slice(xs.length - n) : xs);

/** Fold one row into its lane. Returns a new lane object (the others are untouched). */
export function applyRow(lanes: Record<string, LaneState>, row: LiveRow, now = Date.now()): Record<string, LaneState> {
  const key = `${row.store_id}:${row.lane_id}`;
  const prev = lanes[key] ?? emptyLane(row.store_id, row.lane_id);
  const l: LaneState = { ...prev, lastAt: row.at };
  const d = row.data;
  switch (row.type) {
    case "session": {
      const open = d.open === true;
      l.connected = open;
      if (open) {
        l.session = {
          id: String(d.sessionId),
          since: String(d.at),
          ...(typeof d.codec === "string" ? { codec: d.codec } : {}),
          ...(typeof d.channels === "number" ? { channels: d.channels } : {}),
          ...(typeof d.sourceType === "string" ? { sourceType: d.sourceType } : {}),
        };
      } else l.interim = null;
      break;
    }
    case "utterance": {
      const u = d.utterance as LiveUtterance;
      l.utterances = tail([...l.utterances.filter((x) => x.id !== u.id), u], KEEP_UTTERANCES);
      l.interim = null;
      break;
    }
    case "interim":
      l.interim = typeof d.text === "string" && d.text.trim() ? d.text : null;
      break;
    case "status":
      l.status = d.status as TrackerStatus;
      l.statusClock = String(d.clock);
      l.statusAt = now;
      l.audioMinutes = Number(d.audioMinutes ?? l.audioMinutes);
      break;
    case "tracker":
      l.decisions = tail([...l.decisions, d.decision as TrackerDecision], KEEP_DECISIONS);
      break;
    case "draft":
      l.draft = { conversationId: (d.conversationId as string | null) ?? null, lines: (d.lines as DraftLine[]) ?? [] };
      break;
    case "order": {
      const p = d.payload as LiveOrder;
      const old = l.orders.find((o) => o.order_id === p.order_id);
      if (old && old.order_version > p.order_version) break;
      l.orders = [p, ...l.orders.filter((o) => o.order_id !== p.order_id)];
      break;
    }
    case "delivery": {
      const x = d as unknown as LiveDelivery;
      l.deliveries = { ...l.deliveries, [x.webhookId]: x };
      break;
    }
    case "event":
      l.events = tail([...l.events, { event: String(d.event), at: String(d.at) }], KEEP_EVENTS);
      break;
    default:
      break;
  }
  return { ...lanes, [key]: l };
}

export function applyRows(lanes: Record<string, LaneState>, rows: LiveRow[], now = Date.now()): Record<string, LaneState> {
  let out = lanes;
  for (const r of rows) out = applyRow(out, r, now);
  return out;
}

/** Milliseconds left on a tracker timer, counting down on the wall clock since the status arrived. */
export function remainingMs(l: LaneState, timer: string | null | undefined, now = Date.now()): number | null {
  if (!timer || !l.statusClock) return null;
  return Date.parse(timer) - Date.parse(l.statusClock) - (now - l.statusAt);
}

/** Delivery state of an order version, if it has been sent. */
export function deliveryFor(l: LaneState, orderId: string, version: number): LiveDelivery | undefined {
  return Object.values(l.deliveries).find((d) => d.orderId === orderId && d.version === version);
}
