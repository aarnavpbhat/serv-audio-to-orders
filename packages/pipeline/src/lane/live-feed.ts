/**
 * The live view's feed: lane updates written to the live_events table, which
 * the web app streams to the browser (server-sent events). The service and the
 * web app are separate processes; SQLite is the hand-off. This is a display
 * feed, trimmed to the most recent rows; the data store keeps the record.
 */
import type { DB } from "../store/db";
import type { LaneSession, LaneUpdate } from "./lane";

export interface LiveEvent {
  id: number;
  at: number;
  store_id: string;
  lane_id: string;
  type: LaneUpdate["type"];
  data: string;
}

/** Rows kept in live_events; older rows are removed as new ones arrive. */
export const LIVE_KEEP = 20_000;

/** What the browser needs from an update: no word timings, no transcript copy inside order payloads. */
export function toLive(u: LaneUpdate): Record<string, unknown> {
  switch (u.type) {
    case "utterance": {
      const { words: _words, ...rest } = u.utterance;
      return { ...u, utterance: rest };
    }
    case "order": {
      const { transcript: _t, ...rest } = u.payload;
      return { ...u, payload: rest };
    }
    default:
      return { ...u };
  }
}

export function appendLive(db: DB, storeId: string, laneId: string, u: LaneUpdate, now = Date.now()): number {
  const r = db.prepare(`INSERT INTO live_events (at, store_id, lane_id, type, data) VALUES (?, ?, ?, ?, ?)`).run(now, storeId, laneId, u.type, JSON.stringify(toLive(u)));
  const id = Number(r.lastInsertRowid);
  if (id % 500 === 0) db.prepare(`DELETE FROM live_events WHERE id <= ?`).run(id - LIVE_KEEP);
  return id;
}

/** onUpdate handler for a LaneManager that feeds the live view. */
export function liveWriter(db: DB): (lane: LaneSession, u: LaneUpdate) => void {
  return (lane, u) => {
    appendLive(db, lane.storeId, lane.laneId, u);
  };
}

export function liveAfter(db: DB, afterId: number, limit = 500): LiveEvent[] {
  return db.prepare(`SELECT * FROM live_events WHERE id > ? ORDER BY id LIMIT ?`).all(afterId, limit) as LiveEvent[];
}

/** The most recent rows (oldest first), to fill the view when it opens. */
export function liveRecent(db: DB, limit = 3000): LiveEvent[] {
  return (db.prepare(`SELECT * FROM live_events ORDER BY id DESC LIMIT ?`).all(limit) as LiveEvent[]).reverse();
}
