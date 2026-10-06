/**
 * A transcript stream for a recording whose words are already known (the
 * fixture's ground truth, or a prerecorded transcript of the whole file):
 * each utterance is released once the audio covering it has arrived, about as
 * a streaming provider would after endpointing. Audio that never arrived (a
 * pause, a dropped connection) is never transcribed. Times in `FileUtterance`
 * are seconds from the start of the file.
 */
import type { AudioFrame, StreamSession } from "../input/types";
import { CANONICAL_RATE } from "../input/types";
import type { StreamUtterance, StreamWord, TranscriptHandlers, TranscriptStream } from "./types";

/** Seconds of audio after an utterance ends before it is final (endpointing). */
export const ENDPOINT_S = 0.3;

export interface FileUtterance {
  id: string;
  speaker: "crew" | "customer";
  speakerLabel?: string;
  speakerGuessed?: boolean;
  start_s: number;
  end_s: number;
  text: string;
  confidence: number;
  words: StreamWord[];
  language?: string;
}

export class TimedStream implements TranscriptStream {
  private utts: FileUtterance[] | null = null;
  private readonly ready: Promise<void>;
  private covered: { from: number; to: number }[] = [];
  private heardTo = 0;
  private closed = false;

  /**
   * @param source the utterances, now or once known (null: nothing to say)
   * @param offsetS seconds from the start of the file to this session's anchor
   * @param seen utterance ids already emitted on this lane for this file (a reconnect does not repeat them)
   */
  constructor(
    private readonly session: StreamSession,
    source: FileUtterance[] | Promise<FileUtterance[]> | null,
    private readonly offsetS: number,
    private readonly seen: Set<string>,
    private readonly handlers: TranscriptHandlers,
  ) {
    if (source === null || Array.isArray(source)) {
      this.utts = source;
      this.ready = Promise.resolve();
    } else {
      this.ready = source.then(
        (u) => {
          this.utts = u;
          // Release whatever the audio already covered while the transcript was loading.
          this.emitUpTo(this.closed ? this.heardTo : this.heardTo - ENDPOINT_S);
        },
        (e: unknown) => {
          this.utts = [];
          this.handlers.error?.(e as Error);
        },
      );
    }
  }

  push(frame: AudioFrame): void {
    if (this.closed) return;
    const from = this.offsetS + frame.sampleOffset / CANONICAL_RATE;
    const to = from + (frame.pcm[0]?.length ?? 0) / CANONICAL_RATE;
    const last = this.covered.at(-1);
    if (last && from - last.to < 0.05) last.to = Math.max(last.to, to);
    else this.covered.push({ from, to });
    this.heardTo = Math.max(this.heardTo, to);
    this.emitUpTo(this.heardTo - ENDPOINT_S);
  }

  private heard(u: { start_s: number; end_s: number }): boolean {
    const mid = (u.start_s + u.end_s) / 2;
    return this.covered.some((c) => mid >= c.from && mid <= c.to);
  }

  private emitUpTo(t: number): void {
    for (const u of this.utts ?? []) {
      if (u.end_s > t || this.seen.has(u.id)) continue;
      if (u.end_s < (this.covered[0]?.from ?? 0)) continue; // before this session
      this.seen.add(u.id);
      if (!this.heard(u)) continue;
      this.handlers.utterance(this.toStream(u));
    }
  }

  private toStream(u: FileUtterance): StreamUtterance {
    const r = (x: number) => Math.round(x * 1000) / 1000;
    const shift = (x: number) => r(x - this.offsetS);
    return {
      id: u.id,
      sessionId: this.session.sessionId,
      speaker: u.speaker,
      speakerLabel: u.speakerLabel ?? u.speaker,
      ...(u.speakerGuessed ? { speakerGuessed: true } : {}),
      start_s: shift(u.start_s),
      end_s: shift(u.end_s),
      text: u.text,
      confidence: u.confidence,
      ...(u.language ? { language: u.language } : {}),
      words: u.words.map((w) => ({ ...w, start_s: shift(w.start_s), end_s: shift(w.end_s) })),
    };
  }

  watermarkS(): number {
    // Until the transcript is known, nothing heard is final: hold the timers.
    if (!this.utts) return (this.covered[0]?.from ?? this.offsetS) - this.offsetS;
    // The earliest heard utterance that started but is not final yet.
    for (const u of this.utts) {
      if (this.seen.has(u.id) || u.start_s >= this.heardTo) continue;
      if (u.end_s + ENDPOINT_S > this.heardTo) return u.start_s - this.offsetS;
    }
    return Number.POSITIVE_INFINITY;
  }

  /** A pause ends whatever was being said: finalize what was heard, drop the rest. */
  pause(): void {
    this.emitUpTo(this.heardTo);
    for (const u of this.utts ?? []) if (u.start_s < this.heardTo) this.seen.add(u.id);
  }

  resume(): void {}

  async end(): Promise<void> {
    this.closed = true;
    await this.ready;
    // Endpointing on close: anything fully heard is final now.
    this.emitUpTo(this.heardTo);
  }

  close(): void {
    this.closed = true;
  }

  audioMinutes(): number {
    return 0;
  }
}
