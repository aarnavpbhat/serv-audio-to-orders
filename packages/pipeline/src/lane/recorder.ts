/**
 * What a live lane keeps in the data store, beside its orders: each order
 * version's audio (FLAC, from a ring buffer of the lane's mono audio), every
 * Deepgram message per connection, and each session's control events and
 * tracker decisions. Writes never block or fail an order; errors are logged.
 */
import type { DataStore } from "../data/store";
import { keys } from "../data/store";
import { encodeFlac } from "../input/encoders";
import { CANONICAL_RATE } from "../input/types";
import type { TrackerDecision } from "./tracker";

export interface RecorderOptions {
  data: DataStore;
  storeId: string;
  laneId: string;
  /** Audio kept for archiving (ms): the longest conversation plus the reopen window, with room to spare. */
  keepMs: number;
  log: (msg: string) => void;
}

interface Chunk {
  startMs: number;
  pcm: Int16Array;
}

export interface SessionEventLine {
  at: string;
  type: string;
  [k: string]: unknown;
}

export class LaneRecorder {
  private chunks: Chunk[] = [];
  private readonly writes = new Set<Promise<unknown>>();

  constructor(private readonly opts: RecorderOptions) {}

  private track(p: Promise<unknown>): void {
    const q = p.catch((e: unknown) => this.opts.log(`data store write failed: ${(e as Error).message}`)).finally(() => this.writes.delete(q));
    this.writes.add(q);
  }

  /** Mono audio at this lane time (ms since epoch on the lane axis). */
  audio(startMs: number, mono: Int16Array): void {
    this.chunks.push({ startMs, pcm: mono.slice() });
    const cutoff = startMs - this.opts.keepMs;
    while (this.chunks.length && (this.chunks[0] as Chunk).startMs + ((this.chunks[0] as Chunk).pcm.length * 1000) / CANONICAL_RATE < cutoff) this.chunks.shift();
  }

  /** Audio between two lane times; gaps read as silence. Null when none of it is buffered. */
  slice(fromMs: number, toMs: number): Int16Array | null {
    const n = Math.max(0, Math.round(((toMs - fromMs) * CANONICAL_RATE) / 1000));
    if (!n) return null;
    const out = new Int16Array(n);
    let any = false;
    for (const c of this.chunks) {
      const cEnd = c.startMs + (c.pcm.length * 1000) / CANONICAL_RATE;
      if (cEnd <= fromMs || c.startMs >= toMs) continue;
      any = true;
      const dst = Math.round(((c.startMs - fromMs) * CANONICAL_RATE) / 1000);
      const from = Math.max(0, -dst);
      const to = Math.min(c.pcm.length, n - dst);
      if (to > from) out.set(c.pcm.subarray(from, to), dst + from);
    }
    return any ? out : null;
  }

  /** Archive one order version's audio; returns the blob uri (null when there is no audio or the disk guard paused archiving). */
  async archive(fromMs: number, toMs: number, o: { orderId: string; version: number; sessionId: string; startedAt: string }): Promise<string | null> {
    const pcm = this.slice(fromMs, toMs);
    if (!pcm) return null;
    const flac = await encodeFlac([pcm]);
    const { data, storeId, laneId } = this.opts;
    const raw = data.find({ sessionId: o.sessionId, kind: "raw" }).map((r) => r.id);
    const row = await data.put("audio", keys.audio({ storeId, laneId, at: o.startedAt }, o.orderId, o.version), flac, {
      storeId,
      laneId,
      sessionId: o.sessionId,
      orderId: o.orderId,
      orderVersion: o.version,
      derivedFrom: raw,
    });
    return row?.uri ?? null;
  }

  /** Every message one Deepgram connection sent, kept as JSON. */
  asr(sessionId: string, connection: number, messages: unknown[], at: string, model: string): void {
    const { data, storeId, laneId } = this.opts;
    this.track(data.put("asr", keys.asr({ storeId, laneId, at }, sessionId, connection), JSON.stringify(messages), { storeId, laneId, sessionId, modelIds: [model] }));
  }

  /** A session's control events and the tracker decisions made while it was open. */
  events(sessionId: string, openedAt: string, events: SessionEventLine[], decisions: TrackerDecision[]): void {
    const { data, storeId, laneId } = this.opts;
    const lines = [...events, ...decisions.map((d) => ({ ...d, type: "tracker_decision" }))].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!lines.length) return;
    this.track(data.put("events", keys.events({ storeId, laneId, at: openedAt }, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { storeId, laneId, sessionId }));
  }

  /** Wait for pending writes (end of a replay, shutdown). */
  async flush(): Promise<void> {
    while (this.writes.size) await Promise.all([...this.writes]);
  }
}
