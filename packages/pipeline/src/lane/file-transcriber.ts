/**
 * The lane's transcriber when a provider key is set (plan D1: files go through
 * the live path too):
 *
 *   - a file replay (the session names its file) is transcribed once with the
 *     provider's prerecorded API, cached on disk like v1, and its utterances
 *     are released as the audio arrives; reruns and evals cost nothing;
 *   - anything else (an HME connection, the simulator's mic) goes to the live
 *     streaming transcriber.
 *
 * The tracker, finalize and delivery are the same either way.
 */
import { ingest } from "../ingest/ingest";
import type { StreamSession } from "../input/types";
import type { Transcriber, TranscribeOptions, TranscribeResult } from "../transcribe/types";
import { TimedStream, type FileUtterance } from "./timed-stream";
import type { StreamingTranscriber, TranscriptHandlers, TranscriptStream } from "./types";

export interface FileTranscriberOptions extends Omit<TranscribeOptions, "channelMap"> {
  /** Channel roles for stereo files (index -> role); null mixes to one channel. */
  channelMap: TranscribeOptions["channelMap"];
  audioStartUtc: string | null;
}

export class FileOrLiveTranscriber implements StreamingTranscriber {
  readonly name: string;
  private readonly transcripts = new Map<string, Promise<TranscribeResult>>();
  private readonly emitted = new Map<string, Set<string>>();
  /** Billable minutes of prerecorded transcription that were not cached. */
  billedMinutes = 0;

  constructor(
    private readonly prerecorded: Transcriber,
    readonly live: StreamingTranscriber,
    private readonly opts: FileTranscriberOptions,
  ) {
    this.name = `${prerecorded.name} (files) / ${live.name} (live)`;
  }

  nameFor(session: Pick<StreamSession, "sourceType" | "sourceRef">): string {
    return reads(session) ? this.prerecorded.name : this.live.name;
  }

  /** One transcription per file and channel layout, shared by every session that replays it. */
  transcript(file: string, channels: number): Promise<TranscribeResult> {
    const key = `${file}|${channels}`;
    let p = this.transcripts.get(key);
    if (!p) {
      p = (async () => {
        const input = await ingest(file, { audioStartUtc: this.opts.audioStartUtc });
        const r = await this.prerecorded.transcribe(input, { ...this.opts, channelMap: channels > 1 ? this.opts.channelMap : null });
        if (!r.usage.cached) this.billedMinutes += r.usage.audio_minutes;
        return r;
      })();
      this.transcripts.set(key, p);
      // A failure is reported to the stream; a later replay tries again.
      p.catch(() => this.transcripts.delete(key));
    }
    return p;
  }

  open(session: StreamSession, handlers: TranscriptHandlers): TranscriptStream {
    if (!reads(session)) return this.live.open(session, handlers);
    const key = `${session.storeId}:${session.laneId}:${session.sourceRef}`;
    const seen = (session.sourceOffsetS && this.emitted.get(key)) || new Set<string>();
    this.emitted.set(key, seen);
    const utterances = this.transcript(session.sourceRef, session.audio.channels).then((r) =>
      r.transcript.utterances.map(
        (u): FileUtterance => ({
          id: u.id,
          speaker: u.speaker,
          ...(u.speaker_label ? { speakerLabel: u.speaker_label } : {}),
          ...(u.speaker_guessed ? { speakerGuessed: true } : {}),
          start_s: u.start_s,
          end_s: u.end_s,
          text: u.text,
          confidence: u.confidence,
          words: u.words,
          ...(u.language ? { language: u.language } : {}),
        }),
      ),
    );
    return new TimedStream(session, utterances, session.sourceOffsetS ?? 0, seen, handlers);
  }
}

/** Only a replay this process started reads a file; a network session never does, whatever it names. */
function reads<S extends Pick<StreamSession, "sourceType" | "sourceRef">>(session: S): session is S & { sourceRef: string } {
  return !!session.sourceRef && session.sourceType === "file_replay";
}
