import type { IngestResult } from "../ingest/ingest";
import type { Transcript } from "../schemas";

export interface TranscribeOptions {
  channelMap: Record<number, "crew" | "customer"> | null;
  keyterms: string[];
  language: string;
  cacheDir: string;
  lowConfWord: number;
  /** Bypass the on-disk cache. */
  refresh?: boolean;
}

export interface TranscribeUsage {
  provider: string;
  /** Billable audio minutes (duration x channels for multichannel). */
  audio_minutes: number;
  cached: boolean;
  role_llm_calls: number;
}

export interface TranscribeResult {
  transcript: Transcript;
  usage: TranscribeUsage;
}

/** Provider-agnostic transcription. Implementations: deepgram, script (fixture ground truth). */
export interface Transcriber {
  readonly name: string;
  transcribe(input: IngestResult, opts: TranscribeOptions): Promise<TranscribeResult>;
}

/** Asked when phrase cues cannot tell which diarized speaker is the crew. */
export interface RoleJudge {
  pickCrew(samples: { speaker: string; lines: string[] }[]): Promise<string | null>;
}
