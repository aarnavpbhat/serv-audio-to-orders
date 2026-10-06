/**
 * One HME base-station connection -> source messages for the lane.
 * PLACEHOLDER wire format: binary messages are audio in the codec named at
 * connect time; text messages are JSON events (see messages.ts).
 *
 * Time basis is our receive clock (HME's timestamps are not documented). The
 * session anchor is the connect time; audio stays contiguous while it flows,
 * and a burst that resumes after a gap (HME's paused-when-no-vehicle mode) is
 * re-anchored from its own receive time, so the gap is measured, not assumed.
 */
import { newId } from "../../lib/ids";
import { createDecoder, type FrameDecoder, type WireCodec } from "../decoders";
import { CANONICAL_RATE, type ChannelRole, type SourceMessage, type StreamSession } from "../types";
import { parseHmeText } from "./messages";

export interface ConnectionParams {
  storeId: string;
  laneId: string;
  codec: WireCodec | "auto";
  sampleRate: number;
  channels: number;
  channelRoles?: ChannelRole[];
  /** Dev only, set by the server (never by the peer): a fixture to transcribe with the free script transcriber. */
  fixture?: { path: string; offsetS: number };
}

export interface ConnectionOptions {
  now?: () => number;
  /** Every message, before decoding (raw capture). */
  capture?: (kind: "binary" | "text", bytes: Uint8Array, receivedAt: number) => void;
  /** The lane sends more than twice its declared data rate. */
  onRateExceeded?: () => void;
  onError?: (e: Error) => void;
  /** Dev simulator text lines are accepted only when dev routes are on. */
  allowTextLines?: boolean;
}

/** A gap in arrivals longer than this starts a new burst, re-anchored from its own receive time. */
const RESUME_GAP_MS = 1000;

/** Bytes per second a declared format can need; containers and Opus get a generous ceiling. */
export function declaredByteRate(codec: WireCodec | "auto", sampleRate: number, channels: number): number {
  if (codec === "pcm_s16le" || codec === "auto") return sampleRate * 2 * channels;
  if (codec === "mulaw" || codec === "alaw") return sampleRate * channels;
  if (codec === "opus") return (64_000 / 8) * channels;
  if (codec === "wav" || codec === "flac") return sampleRate * 2 * channels;
  return (320_000 / 8) * channels;
}

export class HmeConnection {
  readonly session: StreamSession;
  private readonly decoder: FrameDecoder;
  private readonly now: () => number;
  private readonly anchorMs: number;
  private nextOffset = 0;
  private lastArrivalMs = 0;
  private seq = 0;
  private bytesWindow: { at: number; n: number }[] = [];
  private rateFlagged = false;
  private closed = false;

  constructor(
    readonly params: ConnectionParams,
    private readonly emit: (m: SourceMessage) => void,
    private readonly opts: ConnectionOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.anchorMs = this.now();
    this.session = {
      sessionId: newId("ses"),
      storeId: params.storeId,
      laneId: params.laneId,
      sourceType: "hme_ws",
      audio: { sampleRate: CANONICAL_RATE, channels: params.channels, ...(params.channelRoles ? { channelRoles: params.channelRoles } : {}) },
      timeBasis: "receive_clock",
      anchorAt: new Date(this.anchorMs).toISOString(),
      codecIn: params.codec,
      ...(params.fixture ? { sourceRef: params.fixture.path, sourceOffsetS: params.fixture.offsetS } : {}),
    };
    this.decoder = createDecoder({ codec: params.codec, sampleRate: params.sampleRate, channels: params.channels }, (pcm) => this.onPcm(pcm), {
      onError: (e) => opts.onError?.(e),
    });
    this.emit({ kind: "session_open", session: this.session });
  }

  private onPcm(pcm: Int16Array[]): void {
    if (this.closed && !this.draining) return;
    const len = pcm[0]?.length ?? 0;
    if (!len) return;
    const now = this.now();
    // A new burst after a pause: place it by its own arrival time.
    if (this.lastArrivalMs && now - this.lastArrivalMs > RESUME_GAP_MS) {
      const measured = Math.round(((now - this.anchorMs) / 1000) * CANONICAL_RATE) - len;
      this.nextOffset = Math.max(this.nextOffset, measured);
    }
    this.lastArrivalMs = now;
    const offset = this.nextOffset;
    this.nextOffset += len;
    this.emit({ kind: "audio", frame: { sessionId: this.session.sessionId, seq: this.seq++, sampleOffset: offset, receivedAt: new Date(now).toISOString(), pcm } });
  }

  private draining = false;

  onBinary(data: Uint8Array): void {
    if (this.closed) return;
    const now = this.now();
    this.opts.capture?.("binary", data, now);
    this.checkRate(now, data.length);
    this.decoder.push(data);
  }

  onText(text: string): void {
    if (this.closed) return;
    const now = this.now();
    this.opts.capture?.("text", new TextEncoder().encode(text), now);
    const p = parseHmeText(text);
    const at = new Date(now).toISOString();
    if (p.kind === "line") {
      if (!this.opts.allowTextLines) {
        this.emit({ kind: "control", event: { sessionId: this.session.sessionId, at, type: "unknown", raw: p.raw } });
        return;
      }
      this.emit({ kind: "script_line", line: { sessionId: this.session.sessionId, at, speaker: p.speaker, text: p.text } });
      return;
    }
    // Our receive time is the time basis; a source timestamp is kept in raw for later.
    this.emit({ kind: "control", event: { sessionId: this.session.sessionId, at, type: p.type, raw: p.raw } });
  }

  private checkRate(now: number, n: number): void {
    this.bytesWindow.push({ at: now, n });
    this.bytesWindow = this.bytesWindow.filter((b) => now - b.at <= 10_000);
    if (this.rateFlagged || now - this.anchorMs < 5000) return;
    const span = Math.max(1, Math.min(10_000, now - (this.bytesWindow[0]?.at ?? now))) / 1000;
    const rate = this.bytesWindow.reduce((s, b) => s + b.n, 0) / Math.max(span, 1);
    if (rate > 2 * declaredByteRate(this.params.codec, this.params.sampleRate, this.params.channels)) {
      this.rateFlagged = true;
      this.opts.onRateExceeded?.();
    }
  }

  /** Flush the decoder and close the session. */
  async close(reason: "remote_close" | "error" | "eof"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.draining = true;
    try {
      await this.decoder.end();
    } catch (e) {
      this.opts.onError?.(e as Error);
    } finally {
      this.draining = false;
      this.decoder.close();
    }
    this.emit({ kind: "session_close", sessionId: this.session.sessionId, at: new Date(this.now()).toISOString(), reason });
  }
}
