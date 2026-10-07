import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IngestResult } from "../ingest/ingest";
import { addSeconds } from "../ingest/start-time";
import { newId } from "../lib/ids";
import { FixtureTimeline, Transcript, type Utterance } from "../schemas";
import type { TranscribeOptions, TranscribeResult, Transcriber } from "./types";

/** fixtures/audio/01_simple.mono.clean.mp3 -> fixtures/audio/01_simple.timeline.json */
export function timelinePathFor(file: string): string {
  const dir = path.dirname(file);
  const base = path.basename(file).split(".")[0] ?? "";
  return path.join(dir, `${base}.timeline.json`);
}

export function loadTimeline(file: string): FixtureTimeline | null {
  const p = timelinePathFor(file);
  return existsSync(p) ? FixtureTimeline.parse(JSON.parse(readFileSync(p, "utf8"))) : null;
}

/**
 * Ground-truth "transcriber" for fixture audio: reads the timeline written by
 * fixtures:build. Perfect words and roles, zero API cost. Used to test
 * segmentation and extraction in isolation from ASR errors.
 */
export class ScriptTranscriber implements Transcriber {
  readonly name = "script/ground-truth";

  async transcribe(input: IngestResult, _opts: TranscribeOptions): Promise<TranscribeResult> {
    const timeline = loadTimeline(input.file);
    if (!timeline) throw new Error(`No fixture timeline next to ${input.source_file}; the script transcriber only works on fixtures/audio files`);
    const utterances: Utterance[] = timeline.utterances.map((u) => {
      const tokens = u.text.split(/\s+/).filter(Boolean);
      const step = (u.end_s - u.start_s) / Math.max(1, tokens.length);
      return {
        id: u.id,
        speaker: u.speaker,
        speaker_label: u.speaker,
        start_s: u.start_s,
        end_s: u.end_s,
        start_utc: addSeconds(input.audio_start_utc, u.start_s),
        end_utc: addSeconds(input.audio_start_utc, u.end_s),
        text: u.text,
        confidence: 1,
        ...(u.language ? { language: u.language } : {}),
        words: tokens.map((w, i) => ({
          w,
          start_s: Math.round((u.start_s + i * step) * 1000) / 1000,
          end_s: Math.round((u.start_s + (i + 1) * step) * 1000) / 1000,
          conf: 1,
        })),
      };
    });
    const transcript = Transcript.parse({
      transcript_id: newId("tr"),
      source_file: input.source_file,
      audio: input.audio,
      audio_start_utc: input.audio_start_utc,
      timestamp_source: input.timestamp_source,
      role_source: "script",
      stt: this.name,
      language: null,
      utterances,
    });
    return { transcript, usage: { provider: this.name, audio_minutes: 0, cached: true, role_llm_calls: 0 } };
  }
}
