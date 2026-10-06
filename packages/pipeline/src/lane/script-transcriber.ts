/**
 * Free test transcriber for the live path: emits each fixture utterance (ground
 * truth from the timeline) once the audio covering it has arrived, about as a
 * streaming provider would after endpointing. Audio that never arrived (a
 * pause or a dropped connection) is never transcribed.
 */
import type { AudioFrame, StreamSession } from "../input/types";
import { CANONICAL_RATE } from "../input/types";
import type { FixtureTimeline } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import type { StreamUtterance, StreamingTranscriber, TranscriptHandlers, TranscriptStream } from "./types";

/** Seconds of audio after an utterance ends before it is final (endpointing). */
export const SCRIPT_ENDPOINT_S = 0.3;

export class ScriptStreamingTranscriber implements StreamingTranscriber {
  readonly name = "script/ground-truth";

  /** Emitted fixture utterance ids per fixture file, so a reconnect does not repeat them. */
  private readonly emitted = new Map<string, Set<string>>();

  open(session: StreamSession, handlers: TranscriptHandlers): TranscriptStream {
    const timeline = session.sourceRef ? loadTimeline(session.sourceRef) : null;
    const key = session.sourceRef ?? session.sessionId;
    const seen = this.emitted.get(key) ?? new Set<string>();
    this.emitted.set(key, seen);
    return new ScriptStream(session, timeline, seen, handlers);
  }
}

class ScriptStream implements TranscriptStream {
  /** Seconds from the fixture's recording start to this session's anchor. */
  private readonly offsetS: number;
  private covered: { from: number; to: number }[] = [];
  private heardTo = 0;
  private closed = false;

  constructor(
    private readonly session: StreamSession,
    private readonly timeline: FixtureTimeline | null,
    private readonly seen: Set<string>,
    private readonly handlers: TranscriptHandlers,
  ) {
    this.offsetS = session.sourceOffsetS ?? (timeline ? (Date.parse(session.anchorAt) - Date.parse(timeline.recording_start_utc)) / 1000 : 0);
  }

  push(frame: AudioFrame): void {
    if (this.closed || !this.timeline) return;
    const from = this.offsetS + frame.sampleOffset / CANONICAL_RATE;
    const to = from + (frame.pcm[0]?.length ?? 0) / CANONICAL_RATE;
    const last = this.covered.at(-1);
    if (last && from - last.to < 0.05) last.to = Math.max(last.to, to);
    else this.covered.push({ from, to });
    this.heardTo = Math.max(this.heardTo, to);
    this.emitUpTo(this.heardTo - SCRIPT_ENDPOINT_S);
  }

  private heard(u: { start_s: number; end_s: number }): boolean {
    const mid = (u.start_s + u.end_s) / 2;
    return this.covered.some((c) => mid >= c.from && mid <= c.to);
  }

  private emitUpTo(t: number): void {
    for (const u of this.timeline?.utterances ?? []) {
      if (u.end_s > t || this.seen.has(u.id)) continue;
      if (u.end_s < (this.covered[0]?.from ?? 0)) continue; // before this session
      this.seen.add(u.id);
      if (!this.heard(u)) continue;
      this.handlers.utterance(this.toStream(u));
    }
  }

  private toStream(u: FixtureTimeline["utterances"][number]): StreamUtterance {
    const tokens = u.text.split(/\s+/).filter(Boolean);
    const start = u.start_s - this.offsetS;
    const end = u.end_s - this.offsetS;
    const step = (end - start) / Math.max(1, tokens.length);
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return {
      id: u.id,
      sessionId: this.session.sessionId,
      speaker: u.speaker,
      speakerLabel: u.speaker,
      start_s: r(start),
      end_s: r(end),
      text: u.text,
      confidence: 1,
      ...(u.language ? { language: u.language } : {}),
      words: tokens.map((w, i) => ({ w, start_s: r(start + i * step), end_s: r(start + (i + 1) * step), conf: 1 })),
    };
  }

  pause(): void {}
  resume(): void {}

  async end(): Promise<void> {
    // Endpointing on close: anything fully heard is final now.
    this.emitUpTo(this.heardTo);
    this.closed = true;
  }

  close(): void {
    this.closed = true;
  }

  audioMinutes(): number {
    return 0;
  }
}
