/**
 * pnpm fixtures:build [--all-noise] [--only <id>]
 *
 * Renders fixtures/scripts/*.json to MP3 with known timings:
 *   - TTS per turn (macOS `say`, free and local), distinct crew and customer voices
 *   - stereo (customer left, crew right) at 16 kHz and a mono mix band-limited to 8 kHz like a headset
 *   - synthetic engine idle, wind and car radio noise at clean / moderate / heavy levels
 *   - compilations that concatenate several scripts with gaps, to test segmentation
 * Each script also gets <id>.timeline.json with the exact utterance and order spans.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getConfig } from "@serv/config";
import { decodePcm, encodePcm } from "../lib/ffmpeg";
import { FixtureTimeline, type FixtureScript, type NoiseLevel } from "../schemas";
import { CREW_CHATTER_CUES, matchesAny } from "../segment/cues";
import { loadFixtureScripts } from "./load";
import { deriveVehicleEvents } from "./vehicle-events";

const SR = 16_000;
const CREW_VOICE = "Eddy (English (US))";
const CREW2_VOICE = "Fred";
const SPANISH_VOICE = "Paulina";
const CUSTOMER_VOICES = ["Samantha", "Flo (English (US))", "Shelley (English (US))", "Reed (English (US))", "Sandy (English (US))"];
const NOISE_FACTOR: Record<NoiseLevel, number> = { clean: 0, moderate: 0.2, heavy: 0.55 };

interface Compilation {
  id: string;
  title: string;
  scripts: string[];
  gap_s: number;
  /** Per-gap silences (lane streams); overrides gap_s. */
  gaps_s?: number[];
  noise: NoiseLevel;
  /** Layouts to write (default both). Lane streams are mono only to keep the repo small. */
  layouts?: ("stereo" | "mono")[];
}

interface Rendered {
  customer: Float32Array;
  crew: Float32Array;
  utterances: FixtureTimeline["utterances"];
  orders: FixtureTimeline["orders"];
  duration_s: number;
}

function say(voice: string, text: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("say", ["-v", voice, "-o", out, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`say exited ${code} for voice ${voice}`))));
  });
}

async function tts(cacheDir: string, voice: string, text: string): Promise<Float32Array> {
  const key = createHash("sha1").update(`${voice}|${text}`).digest("hex").slice(0, 16);
  const file = path.join(cacheDir, `${key}.wav`);
  if (!existsSync(file)) await say(voice, text, file);
  return decodePcm(file, SR);
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rms(x: Float32Array): number {
  let s = 0;
  let n = 0;
  for (const v of x) {
    if (Math.abs(v) > 1e-4) {
      s += v * v;
      n++;
    }
  }
  return n ? Math.sqrt(s / n) : 0;
}

function normalize(x: Float32Array): Float32Array {
  let s = 0;
  for (const v of x) s += v * v;
  const r = Math.sqrt(s / Math.max(1, x.length)) || 1;
  for (let i = 0; i < x.length; i++) x[i] = (x[i] ?? 0) / r;
  return x;
}

/** Engine idle rumble + wind gusts + a faint car radio. Deterministic per seed. */
function synthNoise(n: number, seed: number, level: NoiseLevel): Float32Array {
  const rand = mulberry32(seed);
  const engine = new Float32Array(n);
  const wind = new Float32Array(n);
  const radio = new Float32Array(n);
  let brown = 0;
  let lp = 0;
  let gust = 0.5;
  const notes = [220, 261.6, 329.6, 392, 440, 523.3];
  let chord = [0, 2, 4];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const white = rand() * 2 - 1;
    brown = 0.995 * brown + 0.05 * white;
    const hum = Math.sin(2 * Math.PI * 31 * t) + 0.6 * Math.sin(2 * Math.PI * 62 * t) + 0.3 * Math.sin(2 * Math.PI * 93 * t);
    engine[i] = (brown * 3 + hum * 0.4) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.7 * t));
    lp += 0.12 * (white - lp);
    if (i % 1600 === 0) gust = Math.min(1, Math.max(0.15, gust + (rand() - 0.5) * 0.3));
    wind[i] = lp * gust;
    if (i % (SR * 2) === 0) chord = [0, 1, 2].map(() => Math.floor(rand() * notes.length));
    radio[i] = chord.reduce((s, k) => s + Math.sin(2 * Math.PI * (notes[k] ?? 220) * t), 0) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t));
  }
  normalize(engine);
  normalize(wind);
  normalize(radio);
  const w = level === "heavy" ? { e: 0.7, w: 0.8, r: 0.3 } : { e: 0.7, w: 0.4, r: 0.25 };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = w.e * (engine[i] ?? 0) + w.w * (wind[i] ?? 0) + w.r * (radio[i] ?? 0);
  return normalize(out);
}

/** Order spans in utterance-index terms, following the events grouping (split orders share a span). */
function orderUtteranceRanges(script: FixtureScript): [number, number][] {
  const groups = script.events.map((evs) => evs.flatMap((e) => e.source_utterance_ids.map((u) => Number(u.slice(1)))));
  const n = script.turns.length;
  const ranges: [number, number][] = groups.map((g, i) => {
    const first = i === 0 ? 1 : Math.min(...g);
    const next = groups[i + 1];
    const last = next ? Math.min(...next) - 1 : n;
    return [first, last];
  });
  if (!ranges.length) ranges.push([1, n]);
  const out: [number, number][] = [];
  if (ranges.length === script.expected.orders.length) return ranges;
  for (let i = 0; i < script.expected.orders.length; i++) out.push(ranges[0] ?? [1, n]);
  return out;
}

async function renderScript(script: FixtureScript, ttsDir: string, voiceIndex: number): Promise<Rendered> {
  const customerVoice = CUSTOMER_VOICES[voiceIndex % CUSTOMER_VOICES.length] ?? "Samantha";
  const clips: { pcm: Float32Array; turn: FixtureScript["turns"][number] }[] = [];
  for (const turn of script.turns) {
    const voice =
      turn.speaker === "crew" ? CREW_VOICE : turn.speaker === "crew2" ? CREW2_VOICE : turn.lang === "es" ? SPANISH_VOICE : customerVoice;
    clips.push({ pcm: await tts(ttsDir, voice, turn.text), turn });
  }
  const r = script.render;
  let t = r.lead_silence_s;
  const spans: { start: number; end: number }[] = [];
  clips.forEach((c, i) => {
    const dur = c.pcm.length / SR;
    spans.push({ start: t, end: t + dur });
    t += dur + (i === clips.length - 1 ? 0 : c.turn.pause_after_s);
  });
  const total = t + r.tail_silence_s;
  const n = Math.ceil(total * SR);
  const customer = new Float32Array(n);
  const crew = new Float32Array(n);
  clips.forEach((c, i) => {
    const track = c.turn.speaker === "customer" ? customer : crew;
    track.set(c.pcm.subarray(0, Math.max(0, n - Math.round((spans[i]?.start ?? 0) * SR))), Math.round((spans[i]?.start ?? 0) * SR));
  });

  const trimStart = Math.round(r.trim_start_s * SR);
  const trimEnd = n - Math.round(r.trim_end_s * SR);
  const shift = r.trim_start_s;
  const utterances: FixtureTimeline["utterances"] = clips
    .map((c, i) => ({
      id: `u${i + 1}`,
      fixture_id: script.id,
      turn_index: i,
      speaker: c.turn.speaker === "customer" ? ("customer" as const) : ("crew" as const),
      crew_chatter: c.turn.speaker === "crew2" || matchesAny(c.turn.text, CREW_CHATTER_CUES),
      text: c.turn.text,
      ...(c.turn.lang ? { language: c.turn.lang } : {}),
      start_s: round3(Math.max(0, (spans[i]?.start ?? 0) - shift)),
      end_s: round3(Math.min((trimEnd - trimStart) / SR, (spans[i]?.end ?? 0) - shift)),
    }))
    .filter((u) => u.end_s > u.start_s);
  const orders = orderUtteranceRanges(script).map(([a, b], k) => ({
    fixture_id: script.id,
    order_index: k,
    start_s: utterances.find((u) => u.turn_index === a - 1)?.start_s ?? 0,
    end_s: utterances.find((u) => u.turn_index === b - 1)?.end_s ?? (trimEnd - trimStart) / SR,
  }));
  return {
    customer: customer.slice(trimStart, trimEnd),
    crew: crew.slice(trimStart, trimEnd),
    utterances,
    orders,
    duration_s: round3((trimEnd - trimStart) / SR),
  };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

async function writeVariants(
  base: string,
  outDir: string,
  r: Rendered,
  levels: NoiseLevel[],
  fixtureIds: string[],
  scripts: Map<string, FixtureScript>,
  layouts: ("stereo" | "mono")[] = ["stereo", "mono"],
): Promise<string[]> {
  const written: string[] = [];
  const speechRms = Math.max(rms(r.customer), rms(r.crew)) || 0.1;
  for (const level of levels) {
    const n = r.customer.length;
    const noise = NOISE_FACTOR[level] > 0 ? synthNoise(n, hashSeed(base + level), level) : null;
    const k = NOISE_FACTOR[level] * speechRms;
    // Stereo: customer mic hears the full engine; the crew headset hears half of it.
    const stereo = new Float32Array(n * 2);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const nz = noise ? (noise[i] ?? 0) * k : 0;
      const c = (r.customer[i] ?? 0) + nz;
      const w = (r.crew[i] ?? 0) + nz * 0.5;
      stereo[2 * i] = clamp(c);
      stereo[2 * i + 1] = clamp(w);
      mono[i] = clamp((r.customer[i] ?? 0) + (r.crew[i] ?? 0) + nz);
    }
    for (const layout of layouts) {
      const file = `${base}.${layout}.${level}.mp3`;
      const out = path.join(outDir, file);
      if (layout === "stereo") {
        await encodePcm(stereo, { sampleRate: SR, channels: 2, out, bitrate: "64k" });
      } else {
        // Headset-like: band-limited and 8 kHz.
        await encodePcm(mono, { sampleRate: SR, channels: 1, out, outRate: 8000, bitrate: "24k", filter: "highpass=f=250,lowpass=f=3600" });
      }
      written.push(file);
    }
  }
  const timeline: FixtureTimeline = FixtureTimeline.parse({
    fixture_ids: fixtureIds,
    file: base,
    layout: "stereo",
    noise: levels[0] ?? "clean",
    duration_s: r.duration_s,
    utterances: r.utterances,
    orders: r.orders,
  });
  timeline.vehicle_events = deriveVehicleEvents(timeline, scripts);
  writeFileSync(path.join(outDir, `${base}.timeline.json`), JSON.stringify(timeline, null, 2) + "\n");
  return written;
}

const clamp = (v: number) => (v > 0.99 ? 0.99 : v < -0.99 ? -0.99 : v);

function concat(parts: Rendered[], gapS: number | number[]): Rendered {
  const gapAt = (i: number) => Math.round((Array.isArray(gapS) ? (gapS[i] ?? gapS.at(-1) ?? 10) : gapS) * SR);
  const n = parts.reduce((s, p, i) => s + p.customer.length + (i < parts.length - 1 ? gapAt(i) : 0), 0);
  const customer = new Float32Array(n);
  const crew = new Float32Array(n);
  const utterances: Rendered["utterances"] = [];
  const orders: Rendered["orders"] = [];
  let offset = 0;
  let uid = 0;
  for (const [i, p] of parts.entries()) {
    customer.set(p.customer, offset);
    crew.set(p.crew, offset);
    const off = offset / SR;
    for (const u of p.utterances) utterances.push({ ...u, id: `u${++uid}`, start_s: round3(u.start_s + off), end_s: round3(u.end_s + off) });
    for (const o of p.orders) orders.push({ ...o, start_s: round3(o.start_s + off), end_s: round3(o.end_s + off) });
    offset += p.customer.length + gapAt(i);
  }
  return { customer, crew, utterances, orders, duration_s: round3(n / SR) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "all-noise": { type: "boolean" }, only: { type: "string" } } });
  const cfg = getConfig();
  const fixturesDir = cfg.paths.fixturesDir;
  const outDir = path.join(fixturesDir, "audio");
  const ttsDir = path.join(outDir, "tmp", "tts");
  mkdirSync(ttsDir, { recursive: true });

  const scripts = loadFixtureScripts(path.join(fixturesDir, "scripts"));
  const byId = new Map(scripts.map((s) => [s.id, s]));
  const rendered = new Map<string, Rendered>();
  let count = 0;
  for (const [i, script] of scripts.entries()) {
    const r = await renderScript(script, ttsDir, i);
    rendered.set(script.id, r);
    if (values.only && values.only !== script.id) continue;
    const levels: NoiseLevel[] = values["all-noise"]
      ? [script.render.noise, ...(["clean", "moderate", "heavy"] as const).filter((l) => l !== script.render.noise)]
      : [script.render.noise];
    const files = await writeVariants(script.id, outDir, r, levels, [script.id], byId);
    count += files.length;
    console.log(`${script.id.padEnd(36)} ${r.duration_s.toFixed(1).padStart(5)}s  ${files.join(", ")}`);
  }

  const compFile = path.join(fixturesDir, "compilations.json");
  const comps: Compilation[] = existsSync(compFile) ? (JSON.parse(readFileSync(compFile, "utf8")) as Compilation[]) : [];
  for (const c of comps) {
    if (values.only && values.only !== c.id) continue;
    const parts = c.scripts.map((id) => {
      const r = rendered.get(id);
      if (!r) throw new Error(`compilation ${c.id}: unknown script ${id}`);
      return r;
    });
    const r = concat(parts, c.gaps_s ?? c.gap_s);
    const files = await writeVariants(c.id, outDir, r, [c.noise], c.scripts, byId, c.layouts);
    count += files.length;
    console.log(`${c.id.padEnd(36)} ${r.duration_s.toFixed(1).padStart(5)}s  ${files.join(", ")}`);
  }
  console.log(`\n${count} audio files written to ${path.relative(cfg.repoRoot, outDir)}/`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
