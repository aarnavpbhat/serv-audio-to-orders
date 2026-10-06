/** Files through the live path (D1): prerecorded and cached for a file, streaming for a live connection. */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CANONICAL_RATE, type AudioFrame, type StreamSession } from "../input/types";
import { repoRoot } from "../test-helpers";
import type { Transcriber, TranscribeResult } from "../transcribe/types";
import { FileOrLiveTranscriber } from "./file-transcriber";
import type { StreamUtterance, StreamingTranscriber } from "./types";

const FILE = path.join(repoRoot, "fixtures/audio/01_simple.mono.clean.mp3");
const session = (over: Partial<StreamSession> = {}): StreamSession => ({
  sessionId: "ses_1",
  storeId: "s",
  laneId: "l",
  sourceType: "file_replay",
  audio: { sampleRate: CANONICAL_RATE, channels: 1 },
  timeBasis: "recording_metadata",
  anchorAt: "2026-10-03T18:40:00.000Z",
  codecIn: "pcm_s16le",
  sourceRef: FILE,
  sourceOffsetS: 0,
  ...over,
});
const frame = (atS: number, seconds: number): AudioFrame => ({ sessionId: "ses_1", seq: 0, sampleOffset: atS * CANONICAL_RATE, receivedAt: new Date().toISOString(), pcm: [new Int16Array(seconds * CANONICAL_RATE)] });
const utt = (id: string, start: number, end: number) => ({ id, speaker: "customer" as const, start_s: start, end_s: end, start_utc: "x", end_utc: "y", text: id, confidence: 0.9, words: [{ w: id, start_s: start, end_s: end, conf: 0.9 }] });

function setup() {
  let resolve: (r: TranscribeResult) => void = () => {};
  const result = new Promise<TranscribeResult>((r) => (resolve = r));
  const prerecorded: Transcriber = { name: "stub/prerecorded", transcribe: vi.fn(() => result) };
  const liveOpen = vi.fn();
  const live: StreamingTranscriber = { name: "stub/live", open: liveOpen };
  const t = new FileOrLiveTranscriber(prerecorded, live, { channelMap: null, audioStartUtc: null, keyterms: [], language: "en", cacheDir: "/tmp", lowConfWord: 0.6 });
  const finish = (utterances: ReturnType<typeof utt>[], cached = true) =>
    resolve({ transcript: { utterances } as unknown as TranscribeResult["transcript"], usage: { provider: "stub", audio_minutes: 0.2, cached, role_llm_calls: 0 } });
  return { t, prerecorded, liveOpen, finish };
}

describe("FileOrLiveTranscriber", () => {
  it("a live connection (no file) goes to the streaming transcriber", () => {
    const { t, liveOpen, prerecorded } = setup();
    t.open(session({ sourceRef: undefined, sourceType: "hme_ws" }), { utterance: () => {} });
    expect(liveOpen).toHaveBeenCalledTimes(1);
    expect(prerecorded.transcribe).not.toHaveBeenCalled();
  });

  it("a file is transcribed once; lines are released as audio arrives; timers wait for the transcript", async () => {
    const { t, prerecorded, finish } = setup();
    const got: StreamUtterance[] = [];
    const s = t.open(session(), { utterance: (u) => got.push(u) });
    s.push(frame(0, 4));
    // Transcript not loaded yet: nothing final, and the watermark holds the tracker at the start.
    expect(got).toEqual([]);
    expect(s.watermarkS()).toBe(0);
    finish([utt("u1", 0.5, 2), utt("u2", 5, 6)], false);
    await new Promise((r) => setTimeout(r, 20));
    await vi.waitFor(() => expect(prerecorded.transcribe).toHaveBeenCalledTimes(1));
    expect(got.map((u) => u.id)).toEqual(["u1"]);
    s.push(frame(4, 3));
    expect(got.map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(got[0]?.words[0]?.conf).toBe(0.9);
    // A second replay of the same file reuses the transcript.
    t.open(session({ sessionId: "ses_2" }), { utterance: () => {} });
    expect(prerecorded.transcribe).toHaveBeenCalledTimes(1);
    expect(t.billedMinutes).toBe(0.2);
  });
});
