/**
 * FrameDecoder registry: wire bytes -> canonical 16 kHz PCM (one array per channel).
 *
 * PLACEHOLDER: HME's codec, sample rate and channel layout are not documented.
 * Supported: pcm_s16le, mulaw, alaw, opus (one raw Opus packet per message),
 * and containers (MP3, AAC, WAV, Ogg, FLAC) through a long-running ffmpeg
 * process reading stdin. `auto` sniffs the first bytes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { OpusDecoder } from "opus-decoder";
import { FFMPEG } from "../lib/ffmpeg";
import { Resampler, alawToLinear, deinterleave, floatToInt16, mulawToLinear, s16leToInt16 } from "./pcm";
import { CANONICAL_RATE } from "./types";

export const RAW_CODECS = ["pcm_s16le", "mulaw", "alaw", "opus"] as const;
export const CONTAINER_CODECS = ["mp3", "aac", "wav", "ogg", "flac"] as const;
export type WireCodec = (typeof RAW_CODECS)[number] | (typeof CONTAINER_CODECS)[number];
/** Whitelist of codecs accepted on the wire; anything else is refused before ffmpeg sees it. */
export const WIRE_CODECS: readonly WireCodec[] = [...RAW_CODECS, ...CONTAINER_CODECS];

export interface DecoderSpec {
  codec: WireCodec | "auto";
  /** Input sample rate for raw codecs (containers carry their own). */
  sampleRate: number;
  channels: number;
}

export interface FrameDecoder {
  /** Resolved codec (after sniffing, for auto). */
  readonly codec: string;
  readonly channels: number;
  /** Feed one wire message. Decoded audio arrives through the emit callback (now or later). */
  push(chunk: Uint8Array): void;
  /** Flush and resolve once the last audio has been emitted. */
  end(): Promise<void>;
  /** Stop at once; nothing is emitted afterwards. */
  close(): void;
}

export type Emit = (pcm: Int16Array[]) => void;

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export function isWireCodec(v: string): v is WireCodec {
  return (WIRE_CODECS as readonly string[]).includes(v);
}

/** Container from magic bytes, or null when the bytes look like raw audio. */
export function sniffCodec(b: Uint8Array): WireCodec | null {
  const ascii = (from: number, n: number) => String.fromCharCode(...b.subarray(from, from + n));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (b.length >= 4 && ascii(0, 4) === "OggS") return "ogg";
  if (b.length >= 4 && ascii(0, 4) === "fLaC") return "flac";
  if (b.length >= 3 && ascii(0, 3) === "ID3") return "mp3";
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0) return "aac"; // ADTS
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  return null;
}

class SampleDecoder implements FrameDecoder {
  private readonly resampler: Resampler;
  private carry = new Uint8Array(0);
  private closed = false;

  constructor(
    readonly codec: "pcm_s16le" | "mulaw" | "alaw",
    readonly channels: number,
    sampleRate: number,
    private readonly emit: Emit,
  ) {
    this.resampler = new Resampler(sampleRate, channels);
  }

  push(chunk: Uint8Array): void {
    if (this.closed || !chunk.length) return;
    const bytesPerFrame = (this.codec === "pcm_s16le" ? 2 : 1) * this.channels;
    // Keep any partial sample frame for the next message.
    const data = this.carry.length ? concat(this.carry, chunk) : chunk;
    const usable = data.length - (data.length % bytesPerFrame);
    this.carry = data.slice(usable);
    if (!usable) return;
    const body = data.subarray(0, usable);
    let interleaved: Int16Array;
    if (this.codec === "pcm_s16le") interleaved = s16leToInt16(body);
    else {
      const table = this.codec === "mulaw" ? MULAW : ALAW;
      interleaved = new Int16Array(body.length);
      for (let i = 0; i < body.length; i++) interleaved[i] = table[body[i] ?? 0] ?? 0;
    }
    this.emit(this.resampler.push(deinterleave(interleaved, this.channels)));
  }

  async end(): Promise<void> {
    this.closed = true;
  }

  close(): void {
    this.closed = true;
  }
}

const MULAW = Int16Array.from({ length: 256 }, (_, i) => mulawToLinear(i));
const ALAW = Int16Array.from({ length: 256 }, (_, i) => alawToLinear(i));

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** One raw Opus packet per message (decoded straight to 16 kHz by libopus). */
class OpusFrameDecoder implements FrameDecoder {
  readonly codec = "opus";
  private readonly decoder: OpusDecoder<16000>;
  private readonly ready: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly channels: number,
    private readonly emit: Emit,
    private readonly onError: (e: Error) => void,
  ) {
    this.decoder = new OpusDecoder({ sampleRate: CANONICAL_RATE, channels });
    this.ready = this.decoder.ready;
  }

  push(chunk: Uint8Array): void {
    if (this.closed || !chunk.length) return;
    const packet = chunk.slice();
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => {
        if (this.closed) return;
        const out = this.decoder.decodeFrame(packet);
        if (out.errors.length) this.onError(new DecodeError(`opus: ${out.errors[0]?.message ?? "decode error"}`));
        if (out.samplesDecoded) this.emit(out.channelData.slice(0, this.channels).map(floatToInt16));
      });
  }

  async end(): Promise<void> {
    await this.queue;
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.ready.then(() => this.decoder.free());
  }
}

/** Containers: one ffmpeg process per session, bytes in on stdin, canonical PCM out on stdout. */
class FfmpegStreamDecoder implements FrameDecoder {
  private readonly child: ChildProcessWithoutNullStreams;
  private carry = new Uint8Array(0);
  private closed = false;
  private readonly done: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout> | null;

  constructor(
    readonly codec: WireCodec,
    readonly channels: number,
    private readonly emit: Emit,
    onError: (e: Error) => void,
    /** Kill the process if a session lasts longer than this (decoders must never hang). */
    maxLifetimeMs: number,
  ) {
    // Argument array, never a shell; the format comes from the whitelist above.
    const fmt = codec === "aac" ? ["-f", "aac"] : codec === "mp3" ? ["-f", "mp3"] : codec === "flac" ? ["-f", "flac"] : codec === "ogg" ? ["-f", "ogg"] : ["-f", "wav"];
    this.child = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", ...fmt, "-i", "pipe:0", "-ac", String(channels), "-ar", String(CANONICAL_RATE), "-f", "s16le", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    this.child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-2000)));
    this.child.stdout.on("data", (d: Buffer) => this.onData(d));
    this.child.stdin.on("error", () => {}); // EPIPE after ffmpeg exits on bad input; reported via exit code
    this.done = new Promise((resolve) => {
      this.child.on("close", (code) => {
        if (code && !this.closed) onError(new DecodeError(`ffmpeg ${codec} decoder exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`));
        resolve();
      });
      this.child.on("error", (e) => {
        onError(e);
        resolve();
      });
    });
    this.timer = maxLifetimeMs > 0 ? setTimeout(() => this.close(), maxLifetimeMs) : null;
    this.timer?.unref?.();
  }

  private onData(d: Buffer): void {
    if (this.closed) return;
    const bytes = this.carry.length ? concat(this.carry, d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    const frame = 2 * this.channels;
    const usable = bytes.length - (bytes.length % frame);
    this.carry = bytes.slice(usable);
    if (usable) this.emit(deinterleave(s16leToInt16(bytes.subarray(0, usable)), this.channels));
  }

  push(chunk: Uint8Array): void {
    if (this.closed || !chunk.length || this.child.stdin.destroyed) return;
    this.child.stdin.write(chunk);
  }

  async end(): Promise<void> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    await this.done;
    this.stop();
  }

  close(): void {
    this.stop();
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }

  private stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Decides the codec on the first message when the spec says auto. */
class AutoDecoder implements FrameDecoder {
  private inner: FrameDecoder | null = null;

  constructor(
    private readonly spec: DecoderSpec,
    private readonly make: (codec: WireCodec) => FrameDecoder,
  ) {}

  get codec(): string {
    return this.inner?.codec ?? "auto";
  }

  get channels(): number {
    return this.spec.channels;
  }

  push(chunk: Uint8Array): void {
    // Anything that is not a known container is treated as raw 16-bit PCM.
    this.inner ??= this.make(sniffCodec(chunk) ?? "pcm_s16le");
    this.inner.push(chunk);
  }

  end(): Promise<void> {
    return this.inner?.end() ?? Promise.resolve();
  }

  close(): void {
    this.inner?.close();
  }
}

export interface DecoderOptions {
  onError?: (e: Error) => void;
  /** Per-session ffmpeg lifetime cap (default 6 hours). */
  maxLifetimeMs?: number;
}

export function createDecoder(spec: DecoderSpec, emit: Emit, opts: DecoderOptions = {}): FrameDecoder {
  const onError = opts.onError ?? (() => {});
  if (!Number.isInteger(spec.channels) || spec.channels < 1 || spec.channels > 8) throw new DecodeError(`channels must be 1 to 8, got ${spec.channels}`);
  const make = (codec: WireCodec): FrameDecoder => {
    switch (codec) {
      case "pcm_s16le":
      case "mulaw":
      case "alaw":
        if (!Number.isInteger(spec.sampleRate) || spec.sampleRate < 8000 || spec.sampleRate > 48000) throw new DecodeError(`sample rate must be 8000 to 48000, got ${spec.sampleRate}`);
        return new SampleDecoder(codec, spec.channels, spec.sampleRate, emit);
      case "opus":
        return new OpusFrameDecoder(spec.channels, emit, onError);
      default:
        return new FfmpegStreamDecoder(codec, spec.channels, emit, onError, opts.maxLifetimeMs ?? 6 * 3600_000);
    }
  };
  if (spec.codec === "auto") return new AutoDecoder(spec, make);
  if (!isWireCodec(spec.codec)) throw new DecodeError(`codec "${String(spec.codec)}" is not supported`);
  return make(spec.codec);
}
