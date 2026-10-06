import { describe, expect, it } from "vitest";
import type { SourceMessage } from "../types";
import { HmeConnection, declaredByteRate } from "./connection";
import { parseHmeText } from "./messages";

describe("HME connection (placeholder format)", () => {
  it("more than twice the declared data rate is reported once", () => {
    let now = 1_000_000;
    let exceeded = 0;
    const c = new HmeConnection({ storeId: "s", laneId: "l", codec: "pcm_s16le", sampleRate: 8000, channels: 1 }, () => {}, { now: () => now, onRateExceeded: () => exceeded++ });
    expect(declaredByteRate("pcm_s16le", 8000, 1)).toBe(16_000);
    // 10 s at 1.5x: fine.
    for (let i = 0; i < 100; i++) {
      now += 100;
      c.onBinary(new Uint8Array(2400));
    }
    expect(exceeded).toBe(0);
    // Then 3x.
    for (let i = 0; i < 100; i++) {
      now += 100;
      c.onBinary(new Uint8Array(4800));
    }
    expect(exceeded).toBe(1);
  });

  it("a burst after a pause is re-anchored from its own arrival time", () => {
    let now = 0;
    const got: SourceMessage[] = [];
    const c = new HmeConnection({ storeId: "s", laneId: "l", codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, (m) => got.push(m), { now: () => now });
    now = 1000;
    c.onBinary(new Uint8Array(32000)); // 1 s of audio, arrives at 1 s
    now = 31_000; // 30 s later (paused when no vehicle)
    c.onBinary(new Uint8Array(32000));
    const offsets = got.flatMap((m) => (m.kind === "audio" ? [m.frame.sampleOffset] : []));
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(30 * 16000);
  });

  it("text lines from the simulator are only accepted with dev routes", () => {
    const got: SourceMessage[] = [];
    const line = JSON.stringify({ type: "utterance", speaker: "customer", text: "A cheeseburger" });
    new HmeConnection({ storeId: "s", laneId: "l", codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, (m) => got.push(m)).onText(line);
    new HmeConnection({ storeId: "s", laneId: "l", codec: "pcm_s16le", sampleRate: 16000, channels: 1 }, (m) => got.push(m), { allowTextLines: true }).onText(line);
    expect(got.filter((m) => m.kind !== "session_open").map((m) => m.kind)).toEqual(["control", "script_line"]);
  });

  it("the parser never throws and keeps unknown messages", () => {
    expect(parseHmeText("not json")).toMatchObject({ kind: "control", type: "unknown" });
    expect(parseHmeText("[1,2]")).toMatchObject({ kind: "control", type: "unknown" });
    expect(parseHmeText(JSON.stringify({ type: "vehicle_departed", at: "2026-10-03T18:40:00Z" }))).toMatchObject({ kind: "control", type: "vehicle_departed", sourceAt: "2026-10-03T18:40:00.000Z" });
  });
});
