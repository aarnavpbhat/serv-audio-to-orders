/**
 * The audio a reviewer needs: exactly the lines that caused the flag, with 2 s
 * before and after, cut from the order's archived audio (live sessions) or from
 * the run's file (uploads). Returns 16 kHz mono WAV.
 */
import type { Engine } from "../engine";
import { ffmpeg } from "../lib/ffmpeg";
import type { OrderPayload } from "../schemas";

export const CLIP_PAD_S = 2;

/** Lines behind the flag: an unclear item's own lines, else the whole conversation. */
export function flaggedLineIds(p: Pick<OrderPayload, "needs_review" | "transcript">): string[] {
  const ids = new Set(p.needs_review.flatMap((n) => n.source_utterance_ids));
  return ids.size ? p.transcript.filter((u) => ids.has(u.id)).map((u) => u.id) : p.transcript.map((u) => u.id);
}

export interface Clip {
  wav: Buffer;
  /** Seconds into the source the clip starts and ends. */
  fromS: number;
  toS: number;
  lineIds: string[];
}

export async function flaggedClip(engine: Engine, p: OrderPayload, run: { file: string | null; audioStartUtc: string | null }): Promise<Clip | null> {
  const lineIds = flaggedLineIds(p);
  const lines = p.transcript.filter((u) => lineIds.includes(u.id));
  if (!lines.length) return null;
  const startMs = Math.min(...lines.map((u) => Date.parse(u.start_utc)));
  const endMs = Math.max(...lines.map((u) => Date.parse(u.end_utc)));
  let input: { file: string } | { bytes: Buffer };
  let baseMs: number;
  if (p.audio_ref.archive_uri) {
    // The archive starts 0.5 s before the conversation (lane recorder).
    input = { bytes: Buffer.from(await engine.data.blobs.get(p.audio_ref.archive_uri)) };
    baseMs = Date.parse(p.times.started_at) - 500;
  } else if (run.file && run.audioStartUtc) {
    input = { file: run.file };
    baseMs = Date.parse(run.audioStartUtc);
  } else return null;
  const fromS = Math.max(0, (startMs - baseMs) / 1000 - CLIP_PAD_S);
  const toS = (endMs - baseMs) / 1000 + CLIP_PAD_S;
  const src = "file" in input ? input.file : "pipe:0";
  const { stdout } = await ffmpeg(["-ss", fromS.toFixed(3), "-to", toS.toFixed(3), "-i", src, "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"], "bytes" in input ? input.bytes : undefined);
  return { wav: stdout, fromS, toS, lineIds };
}
