/** Deepgram response -> provider-agnostic Transcript. */
import type { IngestResult } from "../ingest/ingest";
import { addSeconds } from "../ingest/start-time";
import { newId } from "../lib/ids";
import { Transcript, type Role, type Utterance, type Word } from "../schemas";
import { assignRoles, diarizationCollapsed, inferTurnRoles } from "./roles";

export interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  language?: string;
}

export interface DgUtterance {
  start: number;
  end: number;
  confidence: number;
  channel: number;
  transcript: string;
  words: DgWord[];
  speaker?: number;
}

export interface DgResponse {
  metadata: { duration: number; channels: number; request_id?: string; models?: string[] };
  results: {
    channels: { alternatives: { transcript: string; confidence: number; words: DgWord[]; languages?: string[] }[]; detected_language?: string }[];
    utterances?: DgUtterance[];
  };
}

export interface NormalizeOptions {
  channelMap: Record<number, Role> | null;
  multichannel: boolean;
  lowConfWord: number;
  /** Labels of diarized speakers decided by an LLM tie-break, if any. */
  crewOverride?: Set<string>;
  stt: string;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function majority(values: (string | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
}

/** Speaker labels and their lines, for role assignment and LLM tie-breaks. */
export function diarizedSamples(raw: DgResponse): { label: string; text: string }[] {
  return (raw.results.utterances ?? []).map((u) => ({ label: `spk${u.speaker ?? 0}`, text: u.transcript }));
}

export function normalizeDeepgram(raw: DgResponse, input: IngestResult, opts: NormalizeOptions): Transcript {
  const source = [...(raw.results.utterances ?? [])].sort((a, b) => a.start - b.start || a.channel - b.channel);
  const labelOf = (u: DgUtterance) => (opts.multichannel ? `ch${u.channel}` : `spk${u.speaker ?? 0}`);
  const roles = opts.multichannel ? null : (opts.crewOverride ?? assignRoles(diarizedSamples(raw)).crew);
  const collapsed = !opts.multichannel && diarizationCollapsed(source.filter((u) => u.transcript.trim()).map(labelOf));

  const utterances: Utterance[] = source
    .filter((u) => u.transcript.trim().length > 0)
    .map((u, i) => {
      const label = labelOf(u);
      const speaker: Role = opts.multichannel
        ? (opts.channelMap?.[u.channel] ?? "customer")
        : roles?.has(label)
          ? "crew"
          : "customer";
      const words: Word[] = u.words.map((w) => ({
        w: w.punctuated_word ?? w.word,
        start_s: round3(w.start),
        end_s: round3(w.end),
        conf: round3(w.confidence),
        ...(w.confidence < opts.lowConfWord ? { low_conf: true } : {}),
      }));
      const language = majority(u.words.map((w) => w.language));
      return {
        id: `u${i + 1}`,
        speaker,
        speaker_label: label,
        start_s: round3(u.start),
        end_s: round3(u.end),
        start_utc: addSeconds(input.audio_start_utc, u.start),
        end_utc: addSeconds(input.audio_start_utc, u.end),
        text: u.transcript.trim(),
        confidence: round3(u.confidence),
        words,
        ...(language ? { language } : {}),
      };
    });

  if (collapsed) {
    const guessed = inferTurnRoles(utterances);
    utterances.forEach((u, i) => {
      u.speaker = guessed[i]!;
      u.speaker_guessed = true;
    });
  }

  const language =
    majority(utterances.flatMap((u) => u.words.map(() => u.language))) ?? raw.results.channels[0]?.detected_language ?? null;

  return Transcript.parse({
    transcript_id: newId("tr"),
    source_file: input.source_file,
    audio: input.audio,
    audio_start_utc: input.audio_start_utc,
    timestamp_source: input.timestamp_source,
    role_source: opts.multichannel ? "channel" : collapsed ? "wording" : "diarization",
    stt: opts.stt,
    language,
    utterances,
  });
}
