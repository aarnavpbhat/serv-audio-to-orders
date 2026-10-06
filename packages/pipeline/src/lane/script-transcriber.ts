/**
 * Free test transcriber for the live path: emits each fixture utterance (ground
 * truth from the timeline) once the audio covering it has arrived, about as a
 * streaming provider would after endpointing. Audio that never arrived (a
 * pause or a dropped connection) is never transcribed.
 */
import type { StreamSession } from "../input/types";
import type { FixtureTimeline } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import { ENDPOINT_S, TimedStream, type FileUtterance } from "./timed-stream";
import type { StreamingTranscriber, TranscriptHandlers, TranscriptStream } from "./types";

/** Seconds of audio after an utterance ends before it is final (endpointing). */
export const SCRIPT_ENDPOINT_S = ENDPOINT_S;

/** A fixture line with evenly spread word times and full confidence. */
function fromTimeline(u: FixtureTimeline["utterances"][number]): FileUtterance {
  const tokens = u.text.split(/\s+/).filter(Boolean);
  const step = (u.end_s - u.start_s) / Math.max(1, tokens.length);
  return {
    id: u.id,
    speaker: u.speaker,
    start_s: u.start_s,
    end_s: u.end_s,
    text: u.text,
    confidence: 1,
    ...(u.language ? { language: u.language } : {}),
    words: tokens.map((w, i) => ({ w, start_s: u.start_s + i * step, end_s: u.start_s + (i + 1) * step, conf: 1 })),
  };
}

export class ScriptStreamingTranscriber implements StreamingTranscriber {
  readonly name = "script/ground-truth";

  /** Emitted fixture utterance ids per lane and file, so a reconnect does not repeat them. */
  private readonly emitted = new Map<string, Set<string>>();

  open(session: StreamSession, handlers: TranscriptHandlers): TranscriptStream {
    const timeline = session.sourceRef ? loadTimeline(session.sourceRef) : null;
    const key = `${session.storeId}:${session.laneId}:${session.sourceRef ?? session.sessionId}`;
    // A session starting at the top of the file is a new replay; a later offset is a reconnect.
    const fresh = !session.sourceOffsetS;
    const seen = (!fresh && this.emitted.get(key)) || new Set<string>();
    this.emitted.set(key, seen);
    const offsetS = session.sourceOffsetS ?? (timeline ? (Date.parse(session.anchorAt) - Date.parse(timeline.recording_start_utc)) / 1000 : 0);
    // No fixture (typed lines in the simulator or Test Lab): there is nothing to hear from the
    // audio, so nothing holds the tracker's timers back. (null would hold them forever.)
    return new TimedStream(session, timeline ? timeline.utterances.map(fromTimeline) : [], offsetS, seen, handlers);
  }
}
