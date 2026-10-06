/** Input layer: decoders to canonical PCM, wire encoders, and the file replay plan. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../test-helpers";
import { createDecoder, sniffCodec, type WireCodec } from "./decoders";
import { decodeFileCanonical, encodeForWire } from "./encoders";
import { FileReplaySource } from "./file-replay";
import { alawToLinear, linearToAlaw, linearToMulaw, mulawToLinear, Resampler } from "./pcm";
import { Scenario, reconnectDelayS } from "./scenario";
import { CANONICAL_RATE, type SourceMessage } from "./types";

const fixture = path.join(repoRoot, "fixtures/audio/01_simple.mono.clean.mp3");

/** A 1 s 440 Hz tone at 16 kHz. */
function tone(seconds = 1, channels = 1): Int16Array[] {
  const n = CANONICAL_RATE * seconds;
  return Array.from({ length: channels }, (_, c) => Int16Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * (440 + c * 220) * i) / CANONICAL_RATE))));
}

async function roundTrip(codec: WireCodec, pcm: Int16Array[], frameMs = 100): Promise<Int16Array[]> {
  const wire = await encodeForWire(pcm, codec, frameMs);
  const parts: Int16Array[][] = [];
  const errors: Error[] = [];
  const d = createDecoder({ codec, sampleRate: CANONICAL_RATE, channels: pcm.length }, (p) => parts.push(p), { onError: (e) => errors.push(e) });
  for (const m of wire) d.push(m);
  await d.end();
  expect(errors).toEqual([]);
  return pcm.map((_, c) => Int16Array.from(parts.flatMap((p) => [...(p[c] ?? [])])));
}

/** Correlation of the decoded signal with the original over the overlapping part (codec delay tolerated). */
function similarity(a: Int16Array, b: Int16Array): number {
  let best = 0;
  for (let lag = 0; lag < 2000; lag += 1) {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    const n = Math.min(a.length, b.length - lag) - 400;
    for (let i = 400; i < n; i += 4) {
      const x = a[i] ?? 0;
      const y = b[i + lag] ?? 0;
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    best = Math.max(best, ab / Math.sqrt(aa * bb || 1));
    if (best > 0.98) break;
  }
  return best;
}

describe("G.711", () => {
  it("mu-law and A-law round-trip within quantization error", () => {
    for (const v of [0, 100, -100, 1000, -1000, 12345, -12345, 32000, -32000]) {
      expect(Math.abs(mulawToLinear(linearToMulaw(v)) - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) * 0.07));
      expect(Math.abs(alawToLinear(linearToAlaw(v)) - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) * 0.07));
    }
  });
});

describe("decoders", () => {
  it("sniffs containers from magic bytes", () => {
    expect(sniffCodec(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBe("wav");
    expect(sniffCodec(new TextEncoder().encode("OggS\0\0"))).toBe("ogg");
    expect(sniffCodec(new TextEncoder().encode("ID3\x04"))).toBe("mp3");
    expect(sniffCodec(Uint8Array.from([0x12, 0x34, 0x56]))).toBeNull();
  });

  it("refuses codecs outside the whitelist", () => {
    expect(() => createDecoder({ codec: "speex" as WireCodec, sampleRate: 16000, channels: 1 }, () => {})).toThrow(/not supported/);
    expect(() => createDecoder({ codec: "pcm_s16le", sampleRate: 4000, channels: 1 }, () => {})).toThrow(/sample rate/);
  });

  it("pcm_s16le keeps partial samples across messages", async () => {
    const out: Int16Array[][] = [];
    const d = createDecoder({ codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, (p) => out.push(p));
    d.push(Uint8Array.from([0x01, 0x00, 0x02]));
    d.push(Uint8Array.from([0x00]));
    await d.end();
    expect(out.flatMap((p) => [...(p[0] ?? [])])).toEqual([1, 2]);
  });

  it("resamples 8 kHz to 16 kHz", () => {
    const r = new Resampler(8000, 1);
    const out = r.push([Int16Array.from({ length: 800 }, (_, i) => i)]);
    expect(out[0]?.length).toBeGreaterThanOrEqual(1598);
    expect(out[0]?.length).toBeLessThanOrEqual(1600);
  });

  for (const codec of ["pcm_s16le", "mulaw", "alaw", "opus", "wav", "flac", "mp3", "aac", "ogg"] as const) {
    it(`${codec} over the wire decodes back to the same audio`, async () => {
      const src = tone(1, codec === "opus" || codec === "ogg" ? 1 : 2);
      const out = await roundTrip(codec, src, codec === "opus" ? 20 : 100);
      for (const [c, ch] of out.entries()) {
        expect(ch.length).toBeGreaterThan(CANONICAL_RATE * 0.85);
        expect(similarity(src[c] as Int16Array, ch)).toBeGreaterThan(0.9);
      }
    }, 20_000);
  }
});

const kinds = (ms: SourceMessage[]) => ms.map((m) => m.kind);

async function collect(src: FileReplaySource): Promise<SourceMessage[]> {
  const out: SourceMessage[] = [];
  for await (const m of src.messages()) out.push(m);
  return out;
}

describe("FileReplaySource", () => {
  it("replays at max speed with the fixture's recording time, not today's", async () => {
    const msgs = await collect(new FileReplaySource(fixture));
    const open = msgs[0];
    expect(open?.kind).toBe("session_open");
    if (open?.kind !== "session_open") return;
    expect(open.session.anchorAt).toBe("2026-10-03T18:40:00.000Z");
    expect(open.session.timeBasis).toBe("recording_metadata");
    const audio = msgs.filter((m) => m.kind === "audio");
    const pcm = await decodeFileCanonical(fixture, 1);
    const samples = audio.reduce((n, m) => n + (m.kind === "audio" ? (m.frame.pcm[0]?.length ?? 0) : 0), 0);
    expect(samples).toBe(pcm[0]?.length);
    expect(kinds(msgs).at(-1)).toBe("session_close");
  });

  it("vehicle events on: arrive and depart come from the timeline", async () => {
    const msgs = await collect(new FileReplaySource(fixture, { scenario: Scenario.parse({ name: "t", vehicle_events: "on" }) }));
    const ev = msgs.flatMap((m) => (m.kind === "control" ? [m.event.type] : []));
    expect(ev).toEqual(["vehicle_arrived", "vehicle_departed"]);
  });

  it("a disconnect closes the session and a reconnect opens a new one, re-anchored", async () => {
    const msgs = await collect(new FileReplaySource(fixture, { scenario: Scenario.parse({ name: "t", disconnects: [{ at_s: 5, for_s: 3 }] }) }));
    const opens = msgs.filter((m) => m.kind === "session_open");
    expect(opens).toHaveLength(2);
    const second = opens[1];
    if (second?.kind !== "session_open") return;
    // HME backoff: 2 s then 4 s, so the link is back 6 s after the drop.
    expect(reconnectDelayS(3)).toBe(6);
    expect(second.session.anchorAt).toBe("2026-10-03T18:40:11.000Z");
    const firstAfter = msgs.find((m) => m.kind === "audio" && m.frame.sessionId === second.session.sessionId);
    expect(firstAfter?.kind === "audio" && firstAfter.frame.sampleOffset).toBe(0);
    expect(msgs.some((m) => m.kind === "session_close" && m.reason === "remote_close")).toBe(true);
  });

  it("paused when no vehicle: no audio between cars, with pause and resume events", async () => {
    const file = path.join(repoRoot, "fixtures/audio/18_back_to_back.mono.clean.mp3");
    const msgs = await collect(new FileReplaySource(file, { scenario: Scenario.parse({ name: "t", audio_mode: "paused_when_no_vehicle", vehicle_events: "on" }) }));
    const ev = msgs.flatMap((m) => (m.kind === "control" ? [m.event.type] : []));
    expect(ev).toEqual(["vehicle_arrived", "vehicle_departed", "stream_paused", "vehicle_arrived", "stream_resumed", "vehicle_departed", "stream_paused"]);
    const anchor = Date.parse("2026-10-03T18:40:00Z");
    const silentFrames = msgs.filter((m) => m.kind === "audio" && Date.parse(m.frame.sourceAt ?? "") - anchor > 16_000 && Date.parse(m.frame.sourceAt ?? "") - anchor < 21_000);
    expect(silentFrames).toHaveLength(0);
  });
});
