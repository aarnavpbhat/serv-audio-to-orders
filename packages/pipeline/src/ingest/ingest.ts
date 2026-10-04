import path from "node:path";
import type { AudioInfo, TimestampSource } from "../schemas";
import { IngestError, levelsDb, peakDb, probeAudio, sha256File } from "./probe";
import { resolveStartTime } from "./start-time";

export interface IngestResult {
  file: string;
  source_file: string;
  hash: string;
  audio: AudioInfo;
  peak_db: number;
  /** RMS dBFS per 100 ms window, for the per-conversation noise estimate. */
  levels_db: number[];
  audio_start_utc: string;
  timestamp_source: TimestampSource;
}

/** Probe, hash and sanity-check an audio file. Throws IngestError for empty, silent or corrupt input. */
export async function ingest(file: string, opts: { audioStartUtc: string | null }): Promise<IngestResult> {
  const audio = await probeAudio(file);
  const peak = await peakDb(file);
  if (peak < -60) throw new IngestError(`Audio is silent (peak ${peak === -Infinity ? "-inf" : peak.toFixed(1)} dBFS)`, "silent");
  const [hash, levels] = await Promise.all([sha256File(file), levelsDb(file)]);
  return {
    file,
    source_file: path.basename(file),
    hash,
    audio,
    peak_db: peak,
    levels_db: levels,
    ...resolveStartTime(file, opts.audioStartUtc),
  };
}
