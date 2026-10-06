import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OrderPayload } from "../schemas";
import { repoRoot, testEngine } from "../test-helpers";
import { flaggedClip, flaggedLineIds } from "./clip";

const BASE = "2026-10-03T18:40:00.000Z";
const at = (s: number) => new Date(Date.parse(BASE) + s * 1000).toISOString();
const line = (id: string, s: number, e: number) => ({ id, speaker: "customer" as const, start_utc: at(s), end_utc: at(e), text: id, confidence: 1 });
const payload = (needs: string[]) =>
  ({
    needs_review: needs.length ? [{ source_utterance_ids: needs }] : [],
    transcript: [line("u1", 1, 3), line("u2", 6, 8), line("u3", 12, 14)],
    audio_ref: { archive_uri: null },
    times: { started_at: at(1) },
  }) as unknown as OrderPayload;

describe("flagged clip", () => {
  it("is the unclear item's own lines, or the whole conversation when no line is unclear", () => {
    expect(flaggedLineIds(payload(["u2"]))).toEqual(["u2"]);
    expect(flaggedLineIds(payload([]))).toEqual(["u1", "u2", "u3"]);
  });

  it("cuts the lines with 2 s either side from the run's file, as 16 kHz WAV", async () => {
    const file = path.join(repoRoot, "fixtures/audio/04_correction.mono.clean.mp3");
    const clip = await flaggedClip(testEngine(), payload(["u2"]), { file, audioStartUtc: BASE });
    expect([clip?.fromS, clip?.toS]).toEqual([4, 10]);
    expect(clip?.wav.subarray(0, 4).toString()).toBe("RIFF");
    // 6 s of 16-bit mono at 16 kHz, plus the header.
    expect(clip?.wav.length).toBeGreaterThan(6 * 16000 * 2 * 0.95);
  });

  it("has nothing to cut without an archive or a file", async () => {
    expect(await flaggedClip(testEngine(), payload(["u2"]), { file: null, audioStartUtc: null })).toBeNull();
  });
});
