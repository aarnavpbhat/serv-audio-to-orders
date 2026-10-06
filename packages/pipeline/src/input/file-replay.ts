/**
 * FileReplaySource: plays a recording as if it were a live HME feed. Emits
 * frames at 1x, Nx or max speed, plus the scenario's vehicle events, pauses
 * and disconnects. Times are the recording's own (recording_start_utc), never
 * today's; receivedAt is the wall clock, as it would be live.
 */
import { getConfig } from "@serv/config";
import { probeAudio } from "../ingest/probe";
import { resolveStartTime } from "../ingest/start-time";
import { sleep as realSleep } from "../lib/retry";
import { newId } from "../lib/ids";
import type { FixtureTimeline } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import { decodeFileCanonical } from "./encoders";
import { DEFAULT_SCENARIO, reconnectDelayS, type Scenario } from "./scenario";
import { CANONICAL_RATE, type AudioSource, type ChannelRole, type ControlEventType, type SourceMessage, type StreamSession } from "./types";

export interface ReplayOptions {
  scenario?: Scenario;
  storeId?: string;
  laneId?: string;
  /** Playback speed: 1 = real time, N = N times faster, "max" = as fast as possible. */
  speed?: number | "max";
  /** Override the recording start (defaults to the fixture's recording_start_utc, then env/filename/mtime). */
  anchorAt?: string;
  /** Seconds of clock ticks after the last audio, so open timers can expire (default 5, or 200 after a final disconnect). */
  tailS?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A message at a recording-time offset (seconds from the replay anchor). */
interface Timed {
  t: number;
  order: number;
  make: () => SourceMessage;
}

const ORDER = { session_close: 0, session_open: 1, control: 2, audio: 3, tick: 4 } as const;

const iso = (ms: number) => new Date(ms).toISOString();

export class FileReplaySource implements AudioSource {
  private closed = false;
  readonly scenario: Scenario;

  constructor(
    readonly file: string,
    private readonly opts: ReplayOptions = {},
  ) {
    this.scenario = opts.scenario ?? DEFAULT_SCENARIO;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async *messages(): AsyncIterable<SourceMessage> {
    const timed = await this.plan();
    const speed = this.opts.speed ?? "max";
    const now = this.opts.now ?? Date.now;
    const sleep = this.opts.sleep ?? realSleep;
    const wallStart = now();
    for (const m of timed) {
      if (this.closed) return;
      if (speed !== "max") {
        const due = wallStart + (m.t * 1000) / speed;
        const wait = due - now();
        if (wait > 0) await sleep(wait);
      }
      yield m.make();
    }
  }

  /** Every message the replay will send, in time order. */
  async plan(): Promise<Timed[]> {
    const sc = this.scenario;
    const cfg = getConfig();
    const now = this.opts.now ?? Date.now;
    const timeline = loadTimeline(this.file);
    const info = await probeAudio(this.file);
    const channels = sc.channels === "stereo" && info.channels >= 2 ? 2 : 1;
    const pcm = await decodeFileCanonical(this.file, channels);
    const total = pcm[0]?.length ?? 0;
    const durS = total / CANONICAL_RATE;
    const anchorMs = Date.parse(this.opts.anchorAt ?? timeline?.recording_start_utc ?? resolveStartTime(this.file, cfg.audioStartUtc.value).audio_start_utc);
    const at = (t: number) => iso(anchorMs + Math.round(t * 1000));
    const roles: ChannelRole[] = channels === 2 ? ["customer", "crew"] : ["mixed"];

    const vehicle = vehicleEvents(timeline, sc, this.file);
    const audible = audibleIntervals(durS, sc, timeline);
    const outages = sc.disconnects.map((d) => ({ from: d.at_s, to: d.reconnect ? d.at_s + reconnectDelayS(d.for_s) : Number.POSITIVE_INFINITY }));
    const connected = (t: number) => !outages.some((o) => t >= o.from && t < o.to);

    const out: Timed[] = [];
    // Sessions: one per connection; each reconnect re-anchors at its own start.
    const starts = [0, ...outages.filter((o) => Number.isFinite(o.to) && o.to < durS).map((o) => o.to)];
    const sessions = starts.map((t0) => ({
      t0,
      session: {
        sessionId: newId("ses"),
        storeId: this.opts.storeId ?? cfg.storeId.value,
        laneId: this.opts.laneId ?? cfg.laneId.value,
        sourceType: "file_replay",
        audio: { sampleRate: CANONICAL_RATE, channels, channelRoles: roles },
        timeBasis: "recording_metadata",
        anchorAt: at(t0),
        codecIn: "pcm_s16le",
        sourceRef: this.file,
      } satisfies StreamSession,
    }));
    const sessionAt = (t: number) => [...sessions].reverse().find((s) => s.t0 <= t);

    for (const s of sessions) out.push({ t: s.t0, order: ORDER.session_open, make: () => ({ kind: "session_open", session: s.session }) });
    for (const o of outages) {
      const s = sessionAt(o.from);
      if (s && o.from < durS) out.push({ t: o.from, order: ORDER.session_close, make: () => ({ kind: "session_close", sessionId: s.session.sessionId, at: at(o.from), reason: "remote_close" }) });
    }

    // Frames for every audible stretch while connected.
    const perFrame = Math.round((CANONICAL_RATE * sc.frame_ms) / 1000);
    let seq = 0;
    for (let start = 0; start < total; start += perFrame) {
      const t = start / CANONICAL_RATE;
      if (!connected(t) || !audible.some((a) => t >= a.from && t < a.to)) continue;
      const s = sessionAt(t);
      if (!s) continue;
      const end = Math.min(total, start + perFrame);
      const frame = pcm.map((ch) => ch.slice(start, end));
      const n = seq++;
      const offset = start - Math.round(s.t0 * CANONICAL_RATE);
      out.push({
        t,
        order: ORDER.audio,
        make: () => ({ kind: "audio", frame: { sessionId: s.session.sessionId, seq: n, sampleOffset: offset, sourceAt: at(t), receivedAt: iso(now()), pcm: frame } }),
      });
    }

    // Control events only reach us while the link is up.
    const control = (t: number, type: ControlEventType) => {
      const s = sessionAt(t);
      if (!s || !connected(t)) return;
      out.push({ t, order: ORDER.control, make: () => ({ kind: "control", event: { sessionId: s.session.sessionId, at: at(t), type, raw: { replay: true, type, t } } }) });
    };
    for (const v of vehicle) control(v.at_s, v.type);
    for (const p of sc.pauses) {
      control(p.at_s, "stream_paused");
      control(p.at_s + p.for_s, "stream_resumed");
    }
    if (sc.audio_mode === "paused_when_no_vehicle") {
      for (const gap of gapsBetween(audible, durS)) {
        control(gap.from, "stream_paused");
        if (gap.to < durS) control(gap.to, "stream_resumed");
      }
    }

    // Clock ticks every second, through gaps and past the end, so timers can expire.
    const finalDrop = sc.disconnects.some((d) => !d.reconnect);
    const tail = this.opts.tailS ?? (finalDrop ? 200 : 5);
    for (let t = 1; t <= durS + tail; t += 1) out.push({ t, order: ORDER.tick, make: () => ({ kind: "tick", at: at(t) }) });

    const lastSession = sessions.at(-1);
    if (lastSession && connected(durS)) {
      out.push({ t: durS + tail, order: ORDER.session_close, make: () => ({ kind: "session_close", sessionId: lastSession.session.sessionId, at: at(durS + tail), reason: "eof" }) });
    }
    return out.sort((a, b) => a.t - b.t || a.order - b.order);
  }
}

interface Interval {
  from: number;
  to: number;
}

/** Stretches with audio: everything (continuous) or only while a car is present, minus explicit pauses. */
function audibleIntervals(durS: number, sc: Scenario, timeline: FixtureTimeline | null): Interval[] {
  let base: Interval[] = [{ from: 0, to: durS }];
  if (sc.audio_mode === "paused_when_no_vehicle" && timeline) {
    // Presence comes from the true vehicle timeline (even when events are off or noisy on the wire).
    base = presence(timeline.vehicle_events, durS);
  }
  for (const p of sc.pauses) base = subtract(base, { from: p.at_s, to: p.at_s + p.for_s });
  return base;
}

function presence(events: FixtureTimeline["vehicle_events"], durS: number): Interval[] {
  const out: Interval[] = [];
  let since: number | null = 0;
  for (const e of [...events].sort((a, b) => a.at_s - b.at_s)) {
    if (e.type === "vehicle_arrived" && since === null) since = e.at_s;
    if (e.type === "vehicle_departed" && since !== null) {
      out.push({ from: since, to: e.at_s });
      since = null;
    }
  }
  if (since !== null) out.push({ from: since, to: durS });
  return out;
}

function subtract(list: Interval[], cut: Interval): Interval[] {
  return list.flatMap((i) => {
    if (cut.to <= i.from || cut.from >= i.to) return [i];
    return [
      ...(cut.from > i.from ? [{ from: i.from, to: cut.from }] : []),
      ...(cut.to < i.to ? [{ from: cut.to, to: i.to }] : []),
    ];
  });
}

function gapsBetween(list: Interval[], durS: number): Interval[] {
  const out: Interval[] = [];
  let t = 0;
  for (const i of list) {
    if (i.from > t) out.push({ from: t, to: i.from });
    t = Math.max(t, i.to);
  }
  if (t < durS) out.push({ from: t, to: durS });
  return out.filter((g) => g.from > 0);
}

/** The scenario's view of vehicle events: none, the true timeline, or a noisy copy (deterministic per file). */
function vehicleEvents(timeline: FixtureTimeline | null, sc: Scenario, seedText: string): FixtureTimeline["vehicle_events"] {
  if (sc.vehicle_events === "off" || !timeline) return [];
  const events = [...timeline.vehicle_events];
  if (sc.vehicle_events === "on") return events;
  const rand = seeded(seedText);
  const kept = events.filter(() => rand() > 0.3);
  // A ghost arrival halfway through one conversation (a car in the next lane, a sensor glitch).
  const span = timeline.orders[Math.floor(rand() * timeline.orders.length)];
  if (span) kept.push({ type: "vehicle_arrived", at_s: Math.round(((span.start_s + span.end_s) / 2) * 1000) / 1000 });
  return kept.sort((a, b) => a.at_s - b.at_s);
}

function seeded(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
