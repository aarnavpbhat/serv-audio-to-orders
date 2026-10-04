import { z } from "zod";

export const Role = z.enum(["crew", "customer"]);
export type Role = z.infer<typeof Role>;

export const Word = z.object({
  w: z.string(),
  start_s: z.number(),
  end_s: z.number(),
  conf: z.number(),
  low_conf: z.boolean().optional(),
});
export type Word = z.infer<typeof Word>;

export const Utterance = z.object({
  id: z.string(),
  speaker: Role,
  /** Raw provider label (channel index or diarized speaker number). */
  speaker_label: z.string().optional(),
  /** Role inferred from wording because diarization could not tell the voices apart. */
  speaker_guessed: z.boolean().optional(),
  start_s: z.number(),
  end_s: z.number(),
  start_utc: z.string(),
  end_utc: z.string(),
  text: z.string(),
  confidence: z.number(),
  words: z.array(Word),
  language: z.string().optional(),
});
export type Utterance = z.infer<typeof Utterance>;

export const AudioInfo = z.object({
  codec: z.string(),
  sample_rate: z.number(),
  channels: z.number(),
  duration_s: z.number(),
});
export type AudioInfo = z.infer<typeof AudioInfo>;

export const TimestampSource = z.enum(["env", "filename", "mtime"]);
export type TimestampSource = z.infer<typeof TimestampSource>;

export const Transcript = z.object({
  transcript_id: z.string(),
  source_file: z.string(),
  audio: AudioInfo,
  audio_start_utc: z.string(),
  timestamp_source: TimestampSource,
  role_source: z.enum(["channel", "diarization", "wording", "script"]),
  stt: z.string(),
  language: z.string().nullable(),
  utterances: z.array(Utterance),
});
export type Transcript = z.infer<typeof Transcript>;
