/**
 * Deepgram live streaming (Nova-3) for one session: canonical PCM in, finalized
 * utterances out within about a second of speech ending.
 *
 * - Separate customer and crew channels -> multichannel; otherwise one mixed
 *   channel with diarization, and roles assigned online from past lines only.
 * - Only finalized results become utterances; interim text goes to the UI.
 * - During pauses a KeepAlive holds the connection; after DEEPGRAM_IDLE_CLOSE_S
 *   it is closed to save credit and reopened on the next audio.
 * - On provider errors: reconnect with backoff, buffer up to 30 s meanwhile,
 *   then send the buffer; audio that could not be kept is reported as a gap.
 * - Deepgram's times count only audio sent on that connection; every send is
 *   recorded so results map back to session time (and then recording time).
 */
import { DeepgramClient } from "@deepgram/sdk";
import { z } from "zod";
import { sleep } from "../lib/retry";
import { CANONICAL_RATE, type AudioFrame, type StreamSession } from "../input/types";
import { int16ToS16le, interleave, mixdown } from "../input/pcm";
import { OnlineRoles } from "./online-roles";
import type { StreamUtterance, StreamWord, StreamingTranscriber, TranscriptHandlers, TranscriptStream } from "./types";

export const DEEPGRAM_LIVE_MODEL = "nova-3";

/** The parts of the SDK's live socket this adapter uses (a fake implements it in tests). */
export interface LiveSocket {
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (m: unknown) => void): void;
  on(event: "close", cb: (e: { code?: number; reason?: string }) => void): void;
  on(event: "error", cb: (e: Error) => void): void;
  connect(): unknown;
  waitForOpen(): Promise<unknown>;
  sendMedia(data: ArrayBufferView): void;
  sendKeepAlive(m: { type: "KeepAlive" }): void;
  sendFinalize(m: { type: "Finalize" }): void;
  sendCloseStream(m: { type: "CloseStream" }): void;
  close(): void;
}

export interface LiveWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  language?: string;
}

export type LiveMessage =
  | { type: "Results"; channel_index: number[]; start: number; duration: number; is_final?: boolean; speech_final?: boolean; channel: { alternatives: { transcript: string; confidence: number; words: LiveWord[] }[] } }
  | { type: "UtteranceEnd"; channel: number[]; last_word_end: number }
  | { type: "SpeechStarted"; channel: number[]; timestamp: number }
  | { type: "Metadata"; [k: string]: unknown };

const Num = z.number().finite();
const IntList = z.array(z.number().int().nonnegative());
const LiveWordSchema = z.looseObject({ word: z.string(), start: Num, end: Num, confidence: Num, punctuated_word: z.string().optional(), speaker: z.number().int().optional(), language: z.string().optional() });
/** Deepgram messages are external input: anything that does not match the shapes we read is dropped. */
const LiveMessageSchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal("Results"),
    channel_index: IntList,
    start: Num,
    duration: Num,
    is_final: z.boolean().optional(),
    speech_final: z.boolean().optional(),
    channel: z.looseObject({ alternatives: z.array(z.looseObject({ transcript: z.string(), confidence: Num, words: z.array(LiveWordSchema) })) }),
  }),
  z.looseObject({ type: z.literal("UtteranceEnd"), channel: IntList, last_word_end: Num }),
  z.looseObject({ type: z.literal("SpeechStarted"), channel: IntList, timestamp: Num }),
  z.looseObject({ type: z.literal("Metadata") }),
]);

export type SocketFactory = (params: Record<string, string | string[]>) => Promise<LiveSocket>;

export interface DeepgramLiveOptions {
  keyterms: string[];
  language: string;
  /** Close the connection after this long paused (seconds); reopen on resume. */
  idleCloseS?: number;
  keepAliveS?: number;
  /** Audio buffered per lane while (re)connecting; older audio is dropped and reported. */
  maxBufferS?: number;
  log?: (msg: string) => void;
}

/** The real connection, through the SDK. Boolean options are strings in SDK v5. */
export function sdkSocketFactory(apiKey: string): SocketFactory {
  const client = new DeepgramClient({ apiKey });
  return async (params) => {
    // reconnectAttempts 0: this adapter reconnects itself so it can buffer and report gaps.
    const args = { ...params, reconnectAttempts: 0 } as unknown as Parameters<typeof client.listen.v1.connect>[0];
    return (await client.listen.v1.connect(args)) as unknown as LiveSocket;
  };
}

export class DeepgramStreamingTranscriber implements StreamingTranscriber {
  readonly name = `deepgram/${DEEPGRAM_LIVE_MODEL}-live`;

  constructor(
    private readonly factory: SocketFactory,
    private readonly opts: DeepgramLiveOptions,
  ) {}

  open(session: StreamSession, handlers: TranscriptHandlers): TranscriptStream {
    return new DeepgramStream(session, handlers, this.factory, this.opts);
  }
}

/** One stretch of audio sent on a connection: where it starts in Deepgram time and in session time. */
interface SendMark {
  dgSample: number;
  sessionSample: number;
}

class DeepgramStream implements TranscriptStream {
  private socket: LiveSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly multichannel: boolean;
  private readonly sendChannels: number;
  private marks: SendMark[] = [];
  private dgSamples = 0;
  private nextSessionSample: number | null = null;
  private totalSamples = 0;
  private buffer: AudioFrame[] = [];
  private paused = false;
  private closed = false;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, LiveWord[]>();
  private readonly inProgress = new Map<number, number>();
  /** Deepgram numbers speakers per connection, so role history restarts with each one. */
  private roles = new OnlineRoles();
  private failures = 0;
  private closedByUs: (() => void) | null = null;
  /** Session seconds Deepgram has finished processing (finals cover up to here). */
  private processedTo = 0;
  /** Session seconds of audio sent so far. */
  private sentTo = 0;
  /** Every message on the current connection, handed to handlers.raw when it closes (data store). */
  private connection = 0;
  private rawMessages: unknown[] = [];
  /** Message types already reported as malformed (logged once each). */
  private readonly unknownTypes = new Set<string>();

  constructor(
    private readonly session: StreamSession,
    private readonly handlers: TranscriptHandlers,
    private readonly factory: SocketFactory,
    private readonly opts: DeepgramLiveOptions,
  ) {
    const roles = session.audio.channelRoles ?? [];
    // Separate channels with known roles -> multichannel; anything else is mixed into one.
    this.multichannel = session.audio.channels > 1 && roles.length === session.audio.channels && roles.every((r) => r !== "mixed");
    this.sendChannels = this.multichannel ? session.audio.channels : 1;
  }

  private params(): Record<string, string | string[]> {
    return {
      model: DEEPGRAM_LIVE_MODEL,
      encoding: "linear16",
      sample_rate: String(CANONICAL_RATE),
      channels: String(this.sendChannels),
      ...(this.multichannel ? { multichannel: "true" } : { diarize: "true" }),
      interim_results: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true",
      smart_format: "true",
      punctuate: "true",
      filler_words: "true",
      language: this.opts.language,
      ...(this.opts.keyterms.length ? { keyterm: this.opts.keyterms } : {}),
    };
  }

  private log(msg: string): void {
    this.opts.log?.(`deepgram ${this.session.sessionId}: ${msg}`);
  }

  private async connect(): Promise<void> {
    this.connecting ??= (async () => {
      for (;;) {
        try {
          const s = await this.factory(this.params());
          s.on("message", (m) => this.onMessage(m));
          s.on("error", (e) => this.handlers.error?.(e));
          s.on("close", (e) => this.onClose(s, e));
          s.connect();
          await s.waitForOpen();
          this.flushRaw();
          this.connection++;
          this.socket = s;
          // Deepgram's clock restarts with each connection.
          this.dgSamples = 0;
          this.marks = [];
          this.roles = new OnlineRoles();
          this.nextSessionSample = null;
          this.failures = 0;
          return;
        } catch (e) {
          this.failures++;
          const wait = Math.min(16_000, 1000 * 2 ** (this.failures - 1));
          this.log(`connect failed (${(e as Error).message}); retry in ${wait / 1000}s`);
          if (this.closed) return;
          await sleep(wait);
        }
      }
    })().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private flushRaw(): void {
    if (this.rawMessages.length && this.handlers.raw) this.handlers.raw(this.connection, this.rawMessages);
    this.rawMessages = [];
  }

  private onClose(s: LiveSocket, e: { code?: number; reason?: string }): void {
    if (this.socket === s) this.flushRaw();
    if (this.closedByUs && this.socket === s) {
      this.closedByUs();
      return;
    }
    if (this.socket !== s) return;
    this.socket = null;
    this.stopKeepAlive();
    if (this.closed || this.paused) return;
    // Unexpected close while streaming: what was in flight is lost unless already final.
    this.log(`connection closed (${e.code ?? "?"} ${e.reason ?? ""}); reconnecting`);
    this.flushAll();
    void this.connect().then(() => this.sendBuffer());
  }

  push(frame: AudioFrame): void {
    if (this.closed) return;
    if (this.paused) this.resume();
    this.buffer.push(frame);
    this.trimBuffer();
    if (this.socket) this.sendBuffer();
    else void this.connect().then(() => this.sendBuffer());
  }

  /** Keep at most maxBufferS of audio waiting; report anything dropped as a transcript gap. */
  private trimBuffer(): void {
    const max = (this.opts.maxBufferS ?? 30) * CANONICAL_RATE;
    let queued = this.buffer.reduce((n, f) => n + (f.pcm[0]?.length ?? 0), 0);
    while (queued > max && this.buffer.length) {
      const f = this.buffer.shift() as AudioFrame;
      const len = f.pcm[0]?.length ?? 0;
      queued -= len;
      this.handlers.gap?.(f.sampleOffset / CANONICAL_RATE, (f.sampleOffset + len) / CANONICAL_RATE, "dropped");
    }
  }

  private sendBuffer(): void {
    const s = this.socket;
    if (!s) return;
    for (const f of this.buffer.splice(0)) {
      const len = f.pcm[0]?.length ?? 0;
      if (this.nextSessionSample !== f.sampleOffset) this.marks.push({ dgSample: this.dgSamples, sessionSample: f.sampleOffset });
      const pcm = this.multichannel ? interleave(f.pcm) : mixdown(f.pcm);
      s.sendMedia(int16ToS16le(pcm));
      this.dgSamples += len;
      this.totalSamples += len;
      this.nextSessionSample = f.sampleOffset + len;
      this.sentTo = this.nextSessionSample / CANONICAL_RATE;
    }
  }

  /** Deepgram seconds (on this connection) -> session seconds. */
  private toSession(t: number): number {
    const sample = t * CANONICAL_RATE;
    let mark = this.marks[0] ?? { dgSample: 0, sessionSample: 0 };
    for (const m of this.marks) if (m.dgSample <= sample + 1) mark = m;
    return (mark.sessionSample + (sample - mark.dgSample)) / CANONICAL_RATE;
  }

  private onMessage(msg: unknown): void {
    if (this.handlers.raw) this.rawMessages.push(msg);
    const parsed = LiveMessageSchema.safeParse(msg);
    if (!parsed.success) {
      const type = typeof msg === "object" && msg !== null && "type" in msg ? String((msg as { type: unknown }).type) : typeof msg;
      if (!this.unknownTypes.has(type)) {
        this.unknownTypes.add(type);
        this.opts.log?.(`deepgram: ignored a ${type} message that did not match the expected shape`);
      }
      return;
    }
    const m = parsed.data as LiveMessage;
    if (m.type === "SpeechStarted") {
      for (const ch of m.channel.slice(0, 1)) if (!this.inProgress.has(ch)) this.inProgress.set(ch, this.toSession(m.timestamp));
      return;
    }
    if (m.type === "UtteranceEnd") {
      this.flush(m.channel[0] ?? 0);
      return;
    }
    if (m.type !== "Results") return;
    const ch = m.channel_index[0] ?? 0;
    const alt = m.channel.alternatives[0];
    if (!alt) return;
    // Interim or final, a result shows how far Deepgram has processed the audio.
    this.processedTo = Math.max(this.processedTo, this.toSession(m.start + m.duration));
    if (!m.is_final) {
      if (alt.transcript.trim()) {
        if (!this.inProgress.has(ch)) this.inProgress.set(ch, this.toSession(alt.words[0]?.start ?? m.start));
        this.handlers.interim?.(alt.transcript, this.session.sessionId);
      }
      return;
    }
    if (alt.words.length) this.pending.set(ch, [...(this.pending.get(ch) ?? []), ...alt.words]);
    if (m.speech_final) this.flush(ch);
  }

  private flushAll(): void {
    for (const ch of [...this.pending.keys()]) this.flush(ch);
    this.inProgress.clear();
  }

  /** Finalized words on a channel -> utterances (split where the diarized speaker changes). */
  private flush(ch: number): void {
    const words = this.pending.get(ch) ?? [];
    this.pending.delete(ch);
    this.inProgress.delete(ch);
    if (!words.length) return;
    const runs: LiveWord[][] = [];
    for (const w of words) {
      const last = runs.at(-1);
      if (last && (this.multichannel || last[0]?.speaker === w.speaker)) last.push(w);
      else runs.push([w]);
    }
    for (const run of runs) this.emit(ch, run);
  }

  private emit(ch: number, run: LiveWord[]): void {
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const words: StreamWord[] = run.map((w) => ({ w: w.punctuated_word ?? w.word, start_s: r3(this.toSession(w.start)), end_s: r3(this.toSession(w.end)), conf: r3(w.confidence) }));
    const text = words.map((w) => w.w).join(" ").trim();
    if (!text) return;
    const label = this.multichannel ? `ch${ch}` : `spk${run[0]?.speaker ?? 0}`;
    const langs = run.map((w) => w.language).filter((l): l is string => !!l);
    const language = langs.length ? mostCommon(langs) : undefined;
    let speaker: "crew" | "customer";
    let guessed = false;
    if (this.multichannel) {
      const role = this.session.audio.channelRoles?.[ch];
      speaker = role === "crew" ? "crew" : "customer";
    } else {
      const pick = this.roles.assign(label, text, words[0]?.start_s ?? 0, words.at(-1)?.end_s ?? 0);
      speaker = pick.role;
      guessed = pick.guessed;
    }
    const u: StreamUtterance = {
      sessionId: this.session.sessionId,
      speaker,
      speakerLabel: label,
      ...(guessed ? { speakerGuessed: true } : {}),
      start_s: words[0]?.start_s ?? 0,
      end_s: words.at(-1)?.end_s ?? 0,
      text,
      confidence: r3(run.reduce((a, w) => a + w.confidence, 0) / run.length),
      words,
      ...(language ? { language } : {}),
    };
    this.handlers.utterance(u);
  }

  watermarkS(): number {
    // Audio sent but not yet processed may hold speech we have not heard about.
    let wm = this.sentTo > this.processedTo + 1 ? this.processedTo : Number.POSITIVE_INFINITY;
    for (const v of this.inProgress.values()) wm = Math.min(wm, v);
    for (const ws of this.pending.values()) if (ws[0]) wm = Math.min(wm, this.toSession(ws[0].start));
    return wm;
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    // Whatever was being said is final now.
    this.socket?.sendFinalize({ type: "Finalize" });
    this.keepAlive = setInterval(() => this.socket?.sendKeepAlive({ type: "KeepAlive" }), (this.opts.keepAliveS ?? 5) * 1000);
    this.keepAlive.unref?.();
    this.idleTimer = setTimeout(() => {
      // Long pause: close to stop paying for an idle connection; reopen on the next audio.
      this.stopKeepAlive();
      const s = this.socket;
      this.socket = null;
      if (s) {
        s.sendCloseStream({ type: "CloseStream" });
        s.close();
      }
      this.log("idle; connection closed until audio resumes");
    }, (this.opts.idleCloseS ?? 30) * 1000);
    this.idleTimer.unref?.();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.stopKeepAlive();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.keepAlive = null;
    this.idleTimer = null;
  }

  async end(): Promise<void> {
    if (this.closed) return;
    if (this.connecting) await this.connecting;
    this.sendBuffer();
    const s = this.socket;
    if (s) {
      // CloseStream: Deepgram sends every remaining result, then closes. Wait for that
      // (bounded by how much audio is still unprocessed), so the last words are not lost.
      const behindS = Math.max(0, this.sentTo - this.processedTo);
      const closed = new Promise<void>((resolve) => (this.closedByUs = resolve));
      s.sendCloseStream({ type: "CloseStream" });
      await Promise.race([closed, sleep(5000 + behindS * 1000)]);
      this.closedByUs = null;
    }
    this.flushAll();
    this.close();
  }

  close(): void {
    this.closed = true;
    this.stopKeepAlive();
    const s = this.socket;
    this.socket = null;
    // Mark before closing so our own close is never mistaken for a dropped connection.
    this.closedByUs ??= () => {};
    s?.close();
    this.flushRaw();
  }

  audioMinutes(): number {
    return Math.round(((this.totalSamples * this.sendChannels) / CANONICAL_RATE / 60) * 1000) / 1000;
  }
}

function mostCommon(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (xs[0] as string);
}
