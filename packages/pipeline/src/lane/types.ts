/** Lane layer: one per store_id:lane_id. Owns the streaming transcriber, the conversation tracker and the clock anchor. */
import type { AudioFrame, StreamSession } from "../input/types";

/** Word times are seconds since the session anchor. */
export interface StreamWord {
  w: string;
  start_s: number;
  end_s: number;
  conf: number;
}

/** A finalized utterance from a streaming transcriber. Times are seconds since the session anchor. */
export interface StreamUtterance {
  /** Provider or fixture id; the lane assigns one when absent. */
  id?: string;
  sessionId: string;
  speaker: "crew" | "customer";
  speakerLabel?: string;
  /** Role inferred from wording because the audio did not separate the voices. */
  speakerGuessed?: boolean;
  start_s: number;
  end_s: number;
  text: string;
  confidence: number;
  words: StreamWord[];
  language?: string;
}

export interface TranscriptHandlers {
  utterance(u: StreamUtterance): void;
  /** Interim (not final) text, for the UI only; never feeds the tracker. */
  interim?(text: string, sessionId: string): void;
  error?(e: Error): void;
  /**
   * Audio between these session offsets was not transcribed: "provider" (error,
   * reconnect) or "dropped" (the 30 s buffer overflowed and the oldest audio was dropped).
   */
  gap?(fromS: number, toS: number, reason?: "provider" | "dropped"): void;
  /** Every provider message on one connection (numbered from 1), when that connection closes. Kept in the data store. */
  raw?(connection: number, messages: unknown[]): void;
}

export interface TranscriptStream {
  push(frame: AudioFrame): void;
  /** No audio for a while (stream paused): keep the provider connection alive or close it to save credit. */
  pause(): void;
  resume(): void;
  /** Flush pending finals and close. */
  end(): Promise<void>;
  /** Close at once. */
  close(): void;
  /** Billable audio minutes sent to the provider so far. */
  audioMinutes(): number;
  /**
   * Session seconds before which nothing is still being said (no utterance is
   * in progress). Timers never run past it, so a close does not settle while
   * the customer is mid-sentence. Infinity when no speech is pending.
   */
  watermarkS(): number;
}

export interface StreamingTranscriber {
  readonly name: string;
  /** The model that actually handles this kind of session, when it depends on the source (files vs live). */
  nameFor?(session: Pick<StreamSession, "sourceType" | "sourceRef">): string;
  open(session: StreamSession, handlers: TranscriptHandlers): TranscriptStream;
}

/** The transcriber name for a session: only the model that applies to it. */
export function sttName(t: StreamingTranscriber, session: Pick<StreamSession, "sourceType" | "sourceRef"> | undefined): string {
  return session && t.nameFor ? t.nameFor(session) : t.name;
}
