/**
 * The simulator's connection to the real endpoint, acting as an HME base
 * station: PLACEHOLDER wire format (binary audio in the declared codec, JSON
 * text for events), a one-time dev ticket per connection, and HME-style
 * reconnects (2, 4, 8 s) after a drop.
 */
import { int16ToS16le, linearToMulaw } from "@serv/pipeline/input/pcm";

export type SimCodec = "pcm_s16le" | "mulaw";
export type LinkState = "idle" | "connecting" | "open" | "reconnecting" | "down";

/** A message for the user: expected events are quiet info notes; errors say what failed and what to do. */
export interface LinkNote {
  tone: "info" | "error";
  text: string;
}

export interface LinkOptions {
  storeId: string;
  laneId: string;
  codec: SimCodec;
  autoReconnect: boolean;
  onState: (s: LinkState, note?: LinkNote) => void;
}

export const RECONNECT_BACKOFF_S = [2, 4, 8];

const FEED_DOWN = "Cannot reach the feed service. Start it with ENABLE_DEV_ROUTES=true pnpm feed serve, then press Start.";

/** Why a connection closed, in plain words. Codes from the server: 4401 revoked, 4409 replaced, 4413 rate, 1009 too big. */
export function describeClose(code: number, reason: string, byUser: boolean): LinkNote {
  if (byUser) return { tone: "info", text: "You dropped the connection." };
  switch (code) {
    case 1000:
      return { tone: "info", text: "Connection closed." };
    case 4000:
      return { tone: "info", text: reason || "Stopped by an operator." };
    case 4409:
      return { tone: "info", text: "Replaced by a newer connection for this lane." };
    case 4401:
      return { tone: "error", text: "The connection's ticket was revoked. Press Start to connect again." };
    case 4413:
      return { tone: "error", text: "Audio arrived faster than its format allows, so the server closed the stream. Press Start to try again." };
    case 1009:
      return { tone: "error", text: "A message was too large for the server. Press Start to try again." };
    case 1001:
      return { tone: "error", text: "The feed service shut down. Start it again, then press Start." };
    default:
      return { tone: "error", text: FEED_DOWN };
  }
}

/** Ask the web app for a one-time ticket bound to this store and lane. */
async function ticket(storeId: string, laneId: string): Promise<{ ticket: string; url: string }> {
  let res: Response;
  try {
    res = await fetch("/api/dev/ingest-ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ store: storeId, lane: laneId }) });
  } catch {
    throw new Error("Cannot reach the web app. Check that pnpm dev is running, then press Start.");
  }
  if (res.status === 404) throw new Error("Dev routes are off. Start the web app with ENABLE_DEV_ROUTES=true pnpm dev, then press Start.");
  if (res.status === 400) throw new Error("Store and lane may use only letters, digits, - and _.");
  if (!res.ok) throw new Error(`Could not get a connection ticket (status ${res.status}). Press Start to try again.`);
  return (await res.json()) as { ticket: string; url: string };
}

/** Encode one frame for the wire. */
export function encodeFrame(pcm: Int16Array, codec: SimCodec): Uint8Array<ArrayBuffer> {
  return codec === "mulaw" ? Uint8Array.from(pcm, (v) => linearToMulaw(v)) : new Uint8Array(int16ToS16le(pcm));
}

export class SimLink {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dropped = false;

  constructor(private opts: LinkOptions) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  set autoReconnect(v: boolean) {
    this.opts = { ...this.opts, autoReconnect: v };
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.opts.onState(this.attempt ? "reconnecting" : "connecting");
    let t: { ticket: string; url: string };
    try {
      t = await ticket(this.opts.storeId, this.opts.laneId);
    } catch (e) {
      this.opts.onState("down", { tone: "error", text: (e as Error).message });
      return;
    }
    if (this.stopped) return;
    const q = new URLSearchParams({ lane: this.opts.laneId, codec: this.opts.codec, rate: "16000", channels: "1", ticket: t.ticket });
    const ws = new WebSocket(`${t.url}?${q}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onState("open");
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const byUser = this.dropped;
      this.dropped = false;
      if (this.stopped) {
        this.opts.onState("idle");
        return;
      }
      const why = describeClose(e.code, e.reason, byUser);
      // An operator stop (4000 from the server) or a revoked ticket is final: never reconnect.
      const final = !byUser && (e.code === 4000 || e.code === 4401);
      const wait = RECONNECT_BACKOFF_S[this.attempt];
      if (!final && this.opts.autoReconnect && wait !== undefined) {
        this.attempt++;
        this.opts.onState("reconnecting", { tone: "info", text: `${why.text} Reconnecting in ${wait} s (try ${this.attempt} of ${RECONNECT_BACKOFF_S.length}).` });
        this.timer = setTimeout(() => void this.connect(), wait * 1000);
      } else if (!final && this.opts.autoReconnect) {
        this.opts.onState("down", { tone: "error", text: `Could not reconnect after ${RECONNECT_BACKOFF_S.length} tries. ${FEED_DOWN}` });
      } else this.opts.onState("down", why);
    };
  }

  sendAudio(pcm: Int16Array): void {
    if (this.open) this.ws?.send(encodeFrame(pcm, this.opts.codec));
  }

  sendEvent(type: "vehicle_arrived" | "vehicle_departed" | "stream_paused" | "stream_resumed"): void {
    if (this.open) this.ws?.send(JSON.stringify({ type, at: new Date().toISOString() }));
  }

  /** Text mode (dev only): a typed line instead of speech. */
  sendLine(speaker: "crew" | "customer", text: string): void {
    if (this.open) this.ws?.send(JSON.stringify({ type: "utterance", speaker, text }));
  }

  /** Drop the connection as a network failure would; reconnects if auto-reconnect is on. */
  drop(): void {
    if (!this.ws) return;
    this.dropped = true;
    this.ws.close(4000, "simulated drop");
  }

  /** Stop for good. */
  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close(1000, "simulator stopped");
    if (!this.ws) this.opts.onState("idle");
  }
}
