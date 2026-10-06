/** Canonical PCM helpers: G.711 tables, little-endian PCM, resampling, channel layout and levels. Pure. */
import { CANONICAL_RATE } from "./types";

/** ITU-T G.711 mu-law byte -> 16-bit linear sample. */
export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -magnitude : magnitude;
}

/** ITU-T G.711 A-law byte -> 16-bit linear sample. */
export function alawToLinear(byte: number): number {
  const a = byte ^ 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  let magnitude = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  if (magnitude > 32767) magnitude = 32767;
  return sign ? magnitude : -magnitude;
}

/** 16-bit linear sample -> G.711 mu-law byte (for the replay encoder and the simulator). */
export function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** 16-bit linear sample -> G.711 A-law byte. */
export function linearToAlaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s >= 0 ? 0x80 : 0;
  if (!sign) s = -s - 1;
  if (s > 32767) s = 32767;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = exponent === 0 ? (s >> 4) & 0x0f : (s >> (exponent + 3)) & 0x0f;
  return ((sign | (exponent << 4) | mantissa) ^ 0x55) & 0xff;
}

/** Interleaved little-endian 16-bit bytes -> Int16Array (copies, so odd offsets are safe). */
export function s16leToInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function int16ToS16le(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

/** Interleaved samples -> one array per channel. */
export function deinterleave(samples: Int16Array, channels: number): Int16Array[] {
  const n = Math.floor(samples.length / channels);
  const out = Array.from({ length: channels }, () => new Int16Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) (out[c] as Int16Array)[i] = samples[i * channels + c] ?? 0;
  return out;
}

export function interleave(channels: Int16Array[]): Int16Array {
  const n = channels[0]?.length ?? 0;
  const out = new Int16Array(n * channels.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels.length; c++) out[i * channels.length + c] = channels[c]?.[i] ?? 0;
  return out;
}

export function floatToInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round((x[i] ?? 0) * 32767)));
  return out;
}

/**
 * Streaming linear resampler to 16 kHz. Keeps its phase and last sample
 * between chunks so frame boundaries do not click. Good enough for speech
 * (Deepgram works on band-limited drive-thru audio anyway).
 */
export class Resampler {
  private pos = 0;
  private last: number[] = [];
  private readonly step: number;

  constructor(
    readonly fromRate: number,
    readonly channels: number,
  ) {
    this.step = fromRate / CANONICAL_RATE;
  }

  push(input: Int16Array[]): Int16Array[] {
    if (this.fromRate === CANONICAL_RATE) return input;
    const n = input[0]?.length ?? 0;
    const out: number[][] = Array.from({ length: this.channels }, () => []);
    // pos is measured from the sample before this chunk (index -1 = last of previous chunk).
    while (this.pos < n) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      for (let c = 0; c < this.channels; c++) {
        const ch = input[c] ?? new Int16Array(n);
        const a = i - 1 < 0 ? (this.last[c] ?? ch[0] ?? 0) : (ch[i - 1] ?? 0);
        const b = ch[i] ?? a;
        (out[c] as number[]).push(Math.round(a + (b - a) * frac));
      }
      this.pos += this.step;
    }
    this.pos -= n;
    this.last = input.map((ch) => ch[n - 1] ?? 0);
    return out.map((xs) => Int16Array.from(xs));
  }
}

/** Mono mix of every channel (used for levels and for a mixed-audio view). */
export function mixdown(channels: Int16Array[]): Int16Array {
  const n = channels[0]?.length ?? 0;
  if (channels.length === 1) return channels[0] ?? new Int16Array(0);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i] ?? 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s / channels.length)));
  }
  return out;
}

/** Same window as ingest/probe.ts LEVEL_WINDOW_S, so snrDb() works on live audio too. */
export const LEVEL_WINDOW_SAMPLES = 1600;

/**
 * Running RMS level (dBFS) per 100 ms window, computed as frames arrive.
 * Silence reads as -120, as in the file path.
 */
export class LevelMeter {
  readonly levels: number[] = [];
  private sum = 0;
  private count = 0;

  push(mono: Int16Array): void {
    for (const v of mono) {
      const x = v / 32768;
      this.sum += x * x;
      if (++this.count === LEVEL_WINDOW_SAMPLES) this.close();
    }
  }

  private close(): void {
    const rms = Math.sqrt(this.sum / Math.max(1, this.count));
    this.levels.push(rms <= 1e-6 ? -120 : Math.max(-120, Math.round(20 * Math.log10(rms) * 10) / 10));
    this.sum = 0;
    this.count = 0;
  }
}
