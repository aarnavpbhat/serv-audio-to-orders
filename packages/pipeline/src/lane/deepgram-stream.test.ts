/** Deepgram live adapter against a fake socket: time mapping, utterance assembly, roles, pauses, reconnects. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_RATE, type AudioFrame, type StreamSession } from "../input/types";
import { DeepgramStreamingTranscriber, type LiveMessage, type LiveSocket, type LiveWord } from "./deepgram-stream";
import type { StreamUtterance } from "./types";

class FakeSocket implements LiveSocket {
  handlers: Record<string, ((x: never) => void)[]> = {};
  media: number[] = [];
  json: string[] = [];
  closed = false;
  constructor(readonly params: Record<string, string | string[]>) {}
  on(event: string, cb: (x: never) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  connect(): void {}
  async waitForOpen(): Promise<void> {}
  sendMedia(d: ArrayBufferView): void {
    this.media.push(d.byteLength);
  }
  sendKeepAlive(): void {
    this.json.push("KeepAlive");
  }
  sendFinalize(): void {
    this.json.push("Finalize");
  }
  sendCloseStream(): void {
    this.json.push("CloseStream");
  }
  close(): void {
    this.closed = true;
  }
  fire(m: LiveMessage): void {
    for (const h of this.handlers.message ?? []) (h as (m: LiveMessage) => void)(m);
  }
  drop(): void {
    for (const h of this.handlers.close ?? []) (h as (e: { code: number }) => void)({ code: 1011 });
  }
}

function setup(channels = 1, roles?: ("customer" | "crew")[]) {
  const sockets: FakeSocket[] = [];
  const t = new DeepgramStreamingTranscriber(async (p) => {
    const s = new FakeSocket(p);
    sockets.push(s);
    return s;
  }, { keyterms: ["Fluffle"], language: "multi", idleCloseS: 30 });
  const session: StreamSession = {
    sessionId: "ses_1",
    storeId: "s",
    laneId: "l",
    sourceType: "hme_ws",
    audio: { sampleRate: CANONICAL_RATE, channels, ...(roles ? { channelRoles: roles } : {}) },
    timeBasis: "receive_clock",
    anchorAt: "2026-10-03T18:40:00.000Z",
    codecIn: "pcm_s16le",
  };
  const utts: StreamUtterance[] = [];
  const interim: string[] = [];
  const gaps: [number, number][] = [];
  const raw: [number, unknown[]][] = [];
  const stream = t.open(session, { utterance: (u) => utts.push(u), interim: (x) => interim.push(x), gap: (a, b) => gaps.push([a, b]), raw: (n, msgs) => raw.push([n, msgs]) });
  return { sockets, stream, utts, interim, gaps, raw };
}

const frame = (offsetS: number, seconds = 1, channels = 1): AudioFrame => ({
  sessionId: "ses_1",
  seq: 0,
  sampleOffset: Math.round(offsetS * CANONICAL_RATE),
  receivedAt: new Date().toISOString(),
  pcm: Array.from({ length: channels }, () => new Int16Array(seconds * CANONICAL_RATE)),
});
const word = (w: string, start: number, speaker = 0): LiveWord => ({ word: w.toLowerCase(), punctuated_word: w, start, end: start + 0.3, confidence: 0.9, speaker });
const results = (words: LiveWord[], final: boolean, speechFinal = false, ch = 0): LiveMessage => ({
  type: "Results",
  channel_index: [ch, 1],
  start: words[0]?.start ?? 0,
  duration: 1,
  is_final: final,
  speech_final: speechFinal,
  channel: { alternatives: [{ transcript: words.map((w) => w.punctuated_word).join(" "), confidence: 0.9, words }] },
});
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.useRealTimers());

describe("Deepgram live adapter", () => {
  it("connects with the plan's parameters (diarize on mixed audio, multichannel with roles)", async () => {
    const mono = setup();
    mono.stream.push(frame(0));
    await tick();
    expect(mono.sockets[0]?.params).toMatchObject({ model: "nova-3", encoding: "linear16", sample_rate: "16000", channels: "1", diarize: "true", interim_results: "true", endpointing: "300", utterance_end_ms: "1000", smart_format: "true", filler_words: "true", language: "multi", keyterm: ["Fluffle"] });
    const stereo = setup(2, ["customer", "crew"]);
    stereo.stream.push(frame(0, 1, 2));
    await tick();
    expect(stereo.sockets[0]?.params).toMatchObject({ channels: "2", multichannel: "true" });
  });

  it("only finalized results become utterances; interim text goes to the UI and holds the watermark", async () => {
    const { sockets, stream, utts, interim } = setup();
    stream.push(frame(0, 3));
    await tick();
    const s = sockets[0] as FakeSocket;
    s.fire(results([word("Hi,", 0.5)], false));
    expect(interim).toEqual(["Hi,"]);
    expect(stream.watermarkS()).toBeCloseTo(0.5);
    s.fire(results([word("Hi,", 0.5), word("cheeseburger", 0.9)], true, false));
    expect(utts).toHaveLength(0);
    s.fire(results([word("please.", 1.4)], true, true));
    expect(utts.map((u) => u.text)).toEqual(["Hi, cheeseburger please."]);
    // Nothing in progress, and Deepgram is within a second of the audio sent.
    expect(stream.watermarkS()).toBe(Number.POSITIVE_INFINITY);
  });

  it("the watermark waits for audio Deepgram has not processed yet", async () => {
    const { sockets, stream } = setup();
    stream.push(frame(0, 10));
    await tick();
    expect(stream.watermarkS()).toBe(0);
    (sockets[0] as FakeSocket).fire({ ...results([], false), start: 0, duration: 9.5 } as LiveMessage);
    expect(stream.watermarkS()).toBe(Number.POSITIVE_INFINITY);
  });

  it("maps Deepgram time back to session time across a gap in what was sent", async () => {
    const { sockets, stream, utts } = setup();
    stream.push(frame(0, 2));
    stream.push(frame(10, 2)); // paused mode: audio resumes at 10 s, Deepgram only saw 2 s so far
    await tick();
    (sockets[0] as FakeSocket).fire(results([word("Hello.", 2.5)], true, true));
    expect(utts[0]?.start_s).toBeCloseTo(10.5);
  });

  it("splits a final at diarized speaker changes and assigns roles from past lines", async () => {
    const { sockets, stream, utts } = setup();
    stream.push(frame(0, 8));
    await tick();
    const s = sockets[0] as FakeSocket;
    s.fire(results([word("Welcome,", 0, 0), word("what", 0.4, 0), word("can", 0.8, 0), word("I", 1.0, 0), word("get", 1.2, 0), word("you?", 1.4, 0), word("A", 2.5, 1), word("cheeseburger.", 2.8, 1)], true, true));
    expect(utts.map((u) => [u.speakerLabel, u.speaker])).toEqual([
      ["spk0", "crew"],
      ["spk1", "customer"],
    ]);
  });

  it("multichannel: roles come from the channel", async () => {
    const { sockets, stream, utts } = setup(2, ["customer", "crew"]);
    stream.push(frame(0, 2, 2));
    await tick();
    (sockets[0] as FakeSocket).fire(results([word("Fries.", 0.5)], true, true, 0));
    (sockets[0] as FakeSocket).fire(results([word("Sure.", 1.2)], true, true, 1));
    expect(utts.map((u) => u.speaker)).toEqual(["customer", "crew"]);
  });

  it("UtteranceEnd flushes words still waiting for speech_final", async () => {
    const { sockets, stream, utts } = setup();
    stream.push(frame(0, 2));
    await tick();
    const s = sockets[0] as FakeSocket;
    s.fire(results([word("Two", 0.2), word("hamburgers", 0.5)], true, false));
    s.fire({ type: "UtteranceEnd", channel: [0, 1], last_word_end: 0.8 });
    expect(utts.map((u) => u.text)).toEqual(["Two hamburgers"]);
  });

  it("a pause sends Finalize and KeepAlives, then closes after the idle limit; audio reopens it", async () => {
    vi.useFakeTimers();
    const { sockets, stream } = setup();
    stream.push(frame(0));
    await vi.advanceTimersByTimeAsync(0);
    stream.pause();
    await vi.advanceTimersByTimeAsync(12_000);
    const s = sockets[0] as FakeSocket;
    expect(s.json.filter((j) => j === "KeepAlive")).toHaveLength(2);
    expect(s.json[0]).toBe("Finalize");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.closed).toBe(true);
    stream.push(frame(60));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
  });

  it("an unexpected close reconnects and sends the buffered audio", async () => {
    const { sockets, stream } = setup();
    stream.push(frame(0));
    await tick();
    (sockets[0] as FakeSocket).drop();
    stream.push(frame(1));
    await tick();
    await tick();
    expect(sockets).toHaveLength(2);
    expect((sockets[1] as FakeSocket).media.length).toBeGreaterThan(0);
  });

  it("audio beyond the 30 s buffer is dropped and reported as a transcript gap", async () => {
    const { stream, gaps } = setup();
    // Never opens: the factory resolves, but pretend we are still connecting by pushing many frames at once.
    for (let i = 0; i < 35; i++) stream.push(frame(i));
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps[0]?.[0]).toBe(0);
  });

  it("hands every provider message to the data store, per connection, when it closes", async () => {
    const { sockets, stream, raw } = setup();
    stream.push(frame(0));
    await tick();
    const a = sockets[0] as FakeSocket;
    a.fire(results([word("Hi", 0.1)], false));
    a.fire(results([word("Hi", 0.1)], true, true));
    a.drop();
    stream.push(frame(1));
    await tick();
    await tick();
    (sockets[1] as FakeSocket).fire(results([word("Fries", 1.1)], true, true));
    stream.close();
    expect(raw.map(([n, msgs]) => [n, msgs.length])).toEqual([
      [1, 2],
      [2, 1],
    ]);
  });

  it("bills audio minutes by samples sent times channels", async () => {
    const { stream } = setup(2, ["customer", "crew"]);
    stream.push(frame(0, 30, 2));
    await tick();
    expect(stream.audioMinutes()).toBe(1);
  });
});
