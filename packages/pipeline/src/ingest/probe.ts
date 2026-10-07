import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { ffmpeg, ffprobe } from "../lib/ffmpeg";
import type { AudioInfo } from "../schemas";

export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: "empty" | "corrupt" | "silent" | "missing",
  ) {
    super(message);
    this.name = "IngestError";
  }
}

interface ProbeJson {
  streams?: { codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }[];
  format?: { duration?: string; format_name?: string };
}

export async function probeAudio(file: string): Promise<AudioInfo> {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new IngestError(`File not found: ${file}`, "missing");
  }
  if (size === 0) throw new IngestError("File is empty (0 bytes)", "empty");
  let json: ProbeJson;
  try {
    const { stdout } = await ffprobe(["-show_entries", "stream=codec_type,codec_name,sample_rate,channels:format=duration,format_name", "-of", "json", file]);
    json = JSON.parse(stdout.toString("utf8")) as ProbeJson;
  } catch (e) {
    throw new IngestError(`Could not read audio: ${(e as Error).message}`, "corrupt");
  }
  const stream = json.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(json.format?.duration ?? NaN);
  if (!stream || !Number.isFinite(duration)) throw new IngestError("No audio stream found", "corrupt");
  if (duration < 0.5) throw new IngestError(`Audio too short (${duration.toFixed(2)}s)`, "empty");
  return {
    codec: stream.codec_name ?? "unknown",
    sample_rate: Number(stream.sample_rate ?? 0),
    channels: stream.channels ?? 1,
    duration_s: Math.round(duration * 1000) / 1000,
  };
}

/** Peak level in dBFS. Below about -60 dB the file is effectively silent. */
export async function peakDb(file: string): Promise<number> {
  const { stderr } = await ffmpeg(["-loglevel", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (!m || m[1] === "-inf") return -Infinity;
  return Number(m[1]);
}

export const LEVEL_WINDOW_S = 0.1;

/** RMS level (dBFS) of each 100 ms window of the mono mix. Silence reads as -120. */
export async function levelsDb(file: string): Promise<number[]> {
  const samples = Math.round(16000 * LEVEL_WINDOW_S);
  const { stderr } = await ffmpeg([
    "-loglevel", "info", "-nostats", "-i", file,
    "-af", `aformat=channel_layouts=mono,aresample=16000,asetnsamples=${samples},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
    "-f", "null", "-",
  ]);
  return [...stderr.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : Math.max(-120, Number(m[1]))));
}

/**
 * Rough signal-to-noise ratio between start_s and end_s: loud windows (speech)
 * against quiet ones (the noise floor between words). Null when too short to judge.
 */
export function snrDb(levels: number[], startS: number, endS: number): number | null {
  const from = Math.max(0, Math.floor(startS / LEVEL_WINDOW_S));
  const to = Math.min(levels.length, Math.ceil(endS / LEVEL_WINDOW_S));
  const win = levels.slice(from, to).sort((a, b) => a - b);
  if (win.length < 20) return null;
  const at = (q: number) => win[Math.min(win.length - 1, Math.floor(q * win.length))]!;
  return Math.round((at(0.9) - at(0.1)) * 10) / 10;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}
