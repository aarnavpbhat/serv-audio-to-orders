import { statSync } from "node:fs";
import path from "node:path";
import type { TimestampSource } from "../schemas";

/**
 * Filename patterns for the recording wall-clock start, e.g.
 *   lane1_20261003T184000Z.mp3, 2026-10-03_18-40-00.mp3, 20261003-184000.mp3
 * Times without a zone are read as UTC.
 */
const PATTERNS: RegExp[] = [
  /(\d{4})-?(\d{2})-?(\d{2})[T_ -](\d{2})[-:]?(\d{2})[-:]?(\d{2})(Z)?/,
];

export function startFromFilename(file: string): string | null {
  const base = path.basename(file);
  for (const re of PATTERNS) {
    const m = re.exec(base);
    if (!m) continue;
    const [, y, mo, d, h, mi, s] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && Number(y) >= 2000) return new Date(t).toISOString();
  }
  return null;
}

export function resolveStartTime(file: string, envValue: string | null): { audio_start_utc: string; timestamp_source: TimestampSource } {
  if (envValue) {
    const t = Date.parse(envValue);
    if (Number.isNaN(t)) throw new Error(`AUDIO_START_UTC is not a valid ISO time: ${envValue}`);
    return { audio_start_utc: new Date(t).toISOString(), timestamp_source: "env" };
  }
  const fromName = startFromFilename(file);
  if (fromName) return { audio_start_utc: fromName, timestamp_source: "filename" };
  return { audio_start_utc: statSync(file).mtime.toISOString(), timestamp_source: "mtime" };
}

export function addSeconds(iso: string, s: number): string {
  return new Date(Date.parse(iso) + Math.round(s * 1000)).toISOString();
}
