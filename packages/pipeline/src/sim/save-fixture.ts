/**
 * Simulator "Save as fixture": one simulator session (every connection on that
 * store and lane in a time range) becomes a fixture folder, written from the
 * raw capture so it holds exactly what the endpoint received:
 *
 *   fixtures/live/<name>/        (or fixtures/heldout/<name>/ when held out)
 *     audio.flac                 canonical 16 kHz mono, pauses kept as silence
 *     raw/<session>/...          the captured parts, byte for byte, with session.json
 *     timeline.json              start time, vehicle and stream events, typed lines, who's-talking labels
 *     expected.json              the expected order, written by hand in the form
 *
 * Held-out fixtures are never used for tuning (plan D8).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readRawSession } from "../data/raw-sink";
import type { Engine } from "../engine";
import { encodeFlac } from "../input/encoders";
import { alawToLinear, mulawToLinear, s16leToInt16 } from "../input/pcm";
import { CANONICAL_RATE } from "../input/types";
import { assertSafeId } from "../lib/safe-id";
import { parseHmeText } from "../input/hme/messages";

export const ExpectedOrder = z.object({
  status: z.enum(["completed", "cancelled", "abandoned", "undetermined"]),
  items: z
    .array(
      z.object({
        catalog_id: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(50),
        size: z.enum(["small", "medium", "large"]).nullable().optional(),
        modifiers: z.array(z.string().max(64)).max(10).optional(),
      }),
    )
    .max(40),
  notes: z.string().max(2000).optional(),
});

export const SaveFixtureInput = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "letters, digits, _ or -"),
  storeId: z.string(),
  laneId: z.string(),
  /** The simulator session's start and end (wall ms). */
  since: z.number().int().nonnegative(),
  until: z.number().int().nonnegative(),
  heldOut: z.boolean().default(false),
  /** One expected order per conversation, in order. */
  expected: z.array(ExpectedOrder).max(20),
  /** "Who's talking" (hold C): labels only, never sent to the pipeline. */
  speakerLabels: z.array(z.object({ start_ms: z.number(), end_ms: z.number(), speaker: z.enum(["crew", "customer"]) })).max(5000).default([]),
});
export type SaveFixtureInput = z.input<typeof SaveFixtureInput>;

export interface SavedFixture {
  dir: string;
  sessions: string[];
  audioSeconds: number;
  lines: number;
  events: number;
}

const RESUME_GAP_MS = 1000;

function decode(codec: string, bytes: Uint8Array): Int16Array {
  if (codec === "pcm_s16le") return s16leToInt16(bytes);
  if (codec === "mulaw") return Int16Array.from(bytes, (b) => mulawToLinear(b));
  if (codec === "alaw") return Int16Array.from(bytes, (b) => alawToLinear(b));
  throw new Error(`Saving fixtures supports the simulator's codecs (pcm_s16le, mulaw, alaw), not ${codec}`);
}

export async function saveLiveFixture(engine: Engine, raw: SaveFixtureInput): Promise<SavedFixture> {
  const input = SaveFixtureInput.parse(raw);
  assertSafeId("store", input.storeId);
  assertSafeId("lane", input.laneId);
  const root = path.join(engine.cfg.paths.fixturesDir, input.heldOut ? "heldout" : "live");
  const dir = path.join(root, assertSafeId("fixture", input.name));

  // Every connection the simulator made on this store and lane during the session.
  const sessions = [
    ...new Set(
      engine.data
        .find({ storeId: input.storeId, kind: "raw" })
        .filter((r) => r.lane_id === input.laneId && r.created_at >= input.since - 5000 && r.created_at <= input.until + 120_000 && r.uri.endsWith("/session.json"))
        .map((r) => r.session_id)
        .filter((s): s is string => !!s),
    ),
  ];
  if (!sessions.length) throw new Error("Nothing was captured on this lane in that time (is the live service running with raw capture on?)");

  const read = await Promise.all(sessions.map((s) => readRawSession(engine.data, s)));
  read.sort((a, b) => Date.parse(a.manifest.opened_at) - Date.parse(b.manifest.opened_at));
  const t0 = Date.parse(read[0]?.manifest.opened_at ?? new Date(input.since).toISOString());

  // Audio on one axis from t0: consecutive within a burst, a new burst placed by its arrival time.
  const chunks: { at: number; pcm: Int16Array }[] = [];
  const events: { type: string; at_s: number }[] = [];
  const lines: { speaker: "crew" | "customer"; text: string; at_s: number }[] = [];
  for (const s of read) {
    if (s.manifest.format.channels !== 1) throw new Error("The simulator sends mono audio; this capture is not mono");
    let next = Math.round(((Date.parse(s.manifest.opened_at) - t0) / 1000) * CANONICAL_RATE);
    let lastArrival = 0;
    events.push({ type: "connected", at_s: (Date.parse(s.manifest.opened_at) - t0) / 1000 });
    for (const m of s.messages) {
      const arrival = Date.parse(m.receivedAt);
      const atS = (arrival - t0) / 1000;
      if (m.kind === "text") {
        const p = parseHmeText(new TextDecoder().decode(m.bytes));
        if (p.kind === "line") lines.push({ speaker: p.speaker, text: p.text, at_s: atS });
        else if (p.type !== "heartbeat" && p.type !== "unknown") events.push({ type: p.type, at_s: atS });
        continue;
      }
      const pcm = decode(s.manifest.format.codec, m.bytes);
      if (lastArrival && arrival - lastArrival > RESUME_GAP_MS) next = Math.max(next, Math.round(atS * CANONICAL_RATE) - pcm.length);
      lastArrival = arrival;
      chunks.push({ at: next, pcm });
      next += pcm.length;
    }
    const lastAt = s.messages.at(-1)?.receivedAt;
    if (lastAt) events.push({ type: "disconnected", at_s: (Date.parse(lastAt) - t0) / 1000 });
  }
  const total = chunks.reduce((n, c) => Math.max(n, c.at + c.pcm.length), 0);
  const audio = new Int16Array(total);
  for (const c of chunks) audio.set(c.pcm, c.at);

  // Created last-step-only, so an existing fixture (even one made a moment ago) is never written into.
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`A fixture named ${input.name} already exists`);
    throw e;
  }
  if (total) writeFileSync(path.join(dir, "audio.flac"), await encodeFlac([audio]));
  for (const s of sessions) {
    for (const r of engine.data.find({ sessionId: s, kind: "raw" })) {
      const out = path.join(dir, "raw", assertSafeId("session", s), path.basename(r.uri));
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, await engine.data.blobs.get(r.uri));
    }
  }
  const timeline = {
    source: "simulator",
    recording_start_utc: new Date(t0).toISOString(),
    store_id: input.storeId,
    lane_id: input.laneId,
    sessions: read.map((s) => ({ session_id: s.manifest.session_id, opened_at: s.manifest.opened_at, codec: s.manifest.format.codec, incomplete: s.incomplete })),
    audio_s: Math.round((total / CANONICAL_RATE) * 1000) / 1000,
    vehicle_events: events.filter((e) => e.type === "vehicle_arrived" || e.type === "vehicle_departed"),
    stream_events: events.filter((e) => e.type !== "vehicle_arrived" && e.type !== "vehicle_departed"),
    text_lines: lines,
    speaker_labels: input.speakerLabels.map((l) => ({ start_s: (l.start_ms - t0) / 1000, end_s: (l.end_ms - t0) / 1000, speaker: l.speaker })),
  };
  writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(timeline, null, 2) + "\n");
  writeFileSync(path.join(dir, "expected.json"), JSON.stringify({ name: input.name, held_out: input.heldOut, written_by: "hand", orders: input.expected }, null, 2) + "\n");
  return { dir, sessions, audioSeconds: timeline.audio_s, lines: lines.length, events: events.length };
}
