/**
 * The simulator's connection to the real endpoint, acting as an HME base
 * station: PLACEHOLDER wire format (binary audio in the declared codec, JSON
 * text for events), a one-time dev ticket per connection, and HME-style
 * reconnects (2, 4, 8 s) after a drop.
 */
import { int16ToS16le, linearToMulaw } from "@serv/pipeline/input/pcm";

export type SimCodec = "pcm_s16le" | "mulaw";
export type LinkState = "idle" | "connecting" | "open" | "reconnecting" | "down";

export interface LinkOptions {
  storeId: string;
  laneId: string;
  codec: SimCodec;
  autoReconnect: boolean;
  onState: (s: LinkState, detail?: string) => void;
}

export const RECONNECT_BACKOFF_S = [2, 4, 8];

/** Ask the web app for a one-time ticket bound to this store and lane. */
async function ticket(storeId: string, laneId: string): Promise<{ ticket: string; url: string }> {
  const res = await fetch("/api/dev/ingest-ticket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ store: storeId, lane: laneId }) });
  if (!res.ok) throw new Error(`ticket refused (${res.status})`);
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
      this.opts.onState("down", (e as Error).message);
      return;
    }
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
      if (this.stopped) {
        this.opts.onState("idle");
        return;
      }
      const wait = RECONNECT_BACKOFF_S[this.attempt];
      if (this.opts.autoReconnect && wait !== undefined) {
        this.attempt++;
        this.opts.onState("reconnecting", `closed (${e.code}); retry in ${wait} s`);
        this.timer = setTimeout(() => void this.connect(), wait * 1000);
      } else this.opts.onState("down", `closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`);
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
    this.ws?.close(4000, "simulated drop");
  }

  /** Stop for good. */
  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000, "simulator stopped");
    if (!this.ws) this.opts.onState("idle");
  }
}
