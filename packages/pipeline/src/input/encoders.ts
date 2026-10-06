/**
 * Wire encoders for replays: turn canonical PCM into what a base station might
 * send (PLACEHOLDER formats), so replays exercise the same decoders live audio uses.
 */
import { ffmpeg } from "../lib/ffmpeg";
import type { WireCodec } from "./decoders";
import { opusAudioPackets } from "./ogg";
import { int16ToS16le, interleave, linearToAlaw, linearToMulaw } from "./pcm";
import { CANONICAL_RATE } from "./types";

/** Canonical audio (one array per channel) -> wire messages of about frameMs each. */
export async function encodeForWire(pcm: Int16Array[], codec: WireCodec, frameMs: number): Promise<Uint8Array[]> {
  const channels = pcm.length;
  const total = pcm[0]?.length ?? 0;
  const perFrame = Math.max(1, Math.round((CANONICAL_RATE * frameMs) / 1000));
  const slices: Int16Array[][] = [];
  for (let s = 0; s < total; s += perFrame) slices.push(pcm.map((ch) => ch.subarray(s, Math.min(total, s + perFrame))));

  if (codec === "pcm_s16le") return slices.map((sl) => int16ToS16le(interleave(sl)));
  if (codec === "mulaw" || codec === "alaw") {
    const f = codec === "mulaw" ? linearToMulaw : linearToAlaw;
    return slices.map((sl) => Uint8Array.from(interleave(sl), (v) => f(v)));
  }

  const raw = Buffer.from(int16ToS16le(interleave(pcm)));
  const input = ["-f", "s16le", "-ar", String(CANONICAL_RATE), "-ac", String(channels), "-i", "pipe:0"];
  if (codec === "opus") {
    // libopus 20 ms packets; each wire message is one packet.
    const { stdout } = await ffmpeg([...input, "-c:a", "libopus", "-b:a", "24k", "-frame_duration", "20", "-application", "voip", "-f", "ogg", "pipe:1"], raw);
    return opusAudioPackets(new Uint8Array(stdout));
  }
  const args: Record<string, string[]> = {
    mp3: ["-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3"],
    aac: ["-c:a", "aac", "-b:a", "48k", "-f", "adts"],
    wav: ["-c:a", "pcm_s16le", "-f", "wav"],
    ogg: ["-c:a", "libopus", "-b:a", "24k", "-f", "ogg"],
    flac: ["-c:a", "flac", "-f", "flac"],
  };
  const { stdout } = await ffmpeg([...input, ...(args[codec] ?? []), "pipe:1"], raw);
  // Container bytes split into as many messages as there are frames.
  const bytes = new Uint8Array(stdout);
  const n = Math.max(1, slices.length);
  const size = Math.ceil(bytes.length / n);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** Any audio file -> canonical PCM with the given channel count. */
export async function decodeFileCanonical(file: string, channels: number): Promise<Int16Array[]> {
  const { stdout } = await ffmpeg(["-i", file, "-ac", String(channels), "-ar", String(CANONICAL_RATE), "-f", "s16le", "pipe:1"]);
  const all = new Int16Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength - (stdout.byteLength % 2)));
  const n = Math.floor(all.length / channels);
  const out = Array.from({ length: channels }, () => new Int16Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) (out[c] as Int16Array)[i] = all[i * channels + c] ?? 0;
  return out;
}

/** Canonical PCM -> FLAC (lossless; the per-order audio archive). */
export async function encodeFlac(pcm: Int16Array[]): Promise<Uint8Array> {
  const raw = Buffer.from(int16ToS16le(interleave(pcm)));
  const { stdout } = await ffmpeg(["-f", "s16le", "-ar", String(CANONICAL_RATE), "-ac", String(pcm.length), "-i", "pipe:0", "-c:a", "flac", "-f", "flac", "pipe:1"], raw);
  return new Uint8Array(stdout);
}
