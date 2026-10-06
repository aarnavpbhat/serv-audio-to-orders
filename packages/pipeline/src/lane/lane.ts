/**
 * LaneSession: everything for one store_id:lane_id. Survives reconnects (state
 * is keyed by lane, not connection). Receives canonical frames and control
 * events, feeds the streaming transcriber, keeps the lane transcript on one
 * time axis (the lane anchor), and turns finished conversations into orders.
 *
 * Conversation boundaries come from the online tracker (step 6) or, in batch
 * mode, from v1's whole-transcript segmentation once the input ends.
 */
import type { Engine } from "../engine";
import { addSeconds } from "../ingest/start-time";
import { CANONICAL_RATE, type ControlEvent, type ScriptLine, type SourceMessage, type StreamSession } from "../input/types";
import { LEVEL_WINDOW_SAMPLES, mixdown } from "../input/pcm";
import { finalizeConversation, type FinalizeResult, type RunOrder } from "../orders/finalize";
import type { Flag, OutcomeEvidence, Segment, Segmentation, Transcript, Utterance } from "../schemas";
import { segmentTranscript } from "../segment/segment";
import type { OutboxRow } from "../store/db";
import type { StreamUtterance, StreamingTranscriber, TranscriptStream } from "./types";
import { addUsage, emptyUsage, type LlmUsage } from "../extract/types";

export interface LaneOptions {
  engine: Engine;
  transcriber: StreamingTranscriber;
  runId: string;
  deliver: boolean;
  /** Wall clock for processing times (received_at, finalized_at). */
  now?: () => number;
  log?: (msg: string) => void;
}

interface SessionState {
  session: StreamSession;
  stream: TranscriptStream;
  anchorMs: number;
  /** (sample offset, wall ms) per received frame, to date when a conversation's audio arrived. */
  receipts: { offset: number; wallMs: number }[];
  open: boolean;
}

/** A stream event on the lane time axis. */
interface LaneEvent {
  atMs: number;
  type: ControlEvent["type"] | "disconnect" | "reconnect";
  sessionId: string;
}

export class LaneSession {
  readonly key: string;
  private anchorMs: number | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly utterances: Utterance[] = [];
  private readonly utteranceSession = new Map<string, string>();
  private readonly events: LaneEvent[] = [];
  private readonly gaps: { fromMs: number; toMs: number }[] = [];
  /** RMS accumulators per 100 ms window on the lane axis. */
  private readonly levelSum: number[] = [];
  private readonly levelCount: number[] = [];
  private nextUtterance = 1;
  private chain: Promise<void> = Promise.resolve();
  private clockMs = 0;
  /** End of the last audio received (recording time), for the transcript duration. */
  private audioEndMs = 0;
  private channels = 1;
  private codecIn = "pcm_s16le";
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private streamMinutes = 0;

  readonly orders: RunOrder[] = [];
  readonly sends: Promise<OutboxRow>[] = [];
  llm: LlmUsage;
  segmentation: Segmentation | null = null;

  constructor(
    readonly storeId: string,
    readonly laneId: string,
    private readonly opts: LaneOptions,
  ) {
    this.key = laneKey(storeId, laneId);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? opts.engine.log;
    this.llm = emptyUsage(opts.engine.gemini?.model ?? "none");
  }

  /** Messages are handled strictly in order; returns once this one is done. */
  handle(m: SourceMessage): Promise<void> {
    this.chain = this.chain.then(() => this.apply(m));
    return this.chain;
  }

  /** Lane clock (recording time, ms). */
  get clock(): number {
    return this.clockMs;
  }

  get transcriptSoFar(): Utterance[] {
    return this.utterances;
  }

  private advance(atMs: number): void {
    if (atMs > this.clockMs) this.clockMs = atMs;
  }

  private async apply(m: SourceMessage): Promise<void> {
    switch (m.kind) {
      case "session_open":
        return this.openSession(m.session);
      case "audio": {
        const s = this.sessions.get(m.frame.sessionId);
        if (!s?.open) return;
        const startMs = s.anchorMs + (m.frame.sampleOffset * 1000) / CANONICAL_RATE;
        s.receipts.push({ offset: m.frame.sampleOffset, wallMs: Date.parse(m.frame.receivedAt) });
        this.meter(startMs, mixdown(m.frame.pcm));
        s.stream.push(m.frame);
        const endMs = startMs + ((m.frame.pcm[0]?.length ?? 0) * 1000) / CANONICAL_RATE;
        this.audioEndMs = Math.max(this.audioEndMs, endMs);
        this.advance(endMs);
        return;
      }
      case "control": {
        const atMs = Date.parse(m.event.at);
        this.events.push({ atMs, type: m.event.type, sessionId: m.event.sessionId });
        const s = this.sessions.get(m.event.sessionId);
        if (m.event.type === "stream_paused") s?.stream.pause();
        if (m.event.type === "stream_resumed") s?.stream.resume();
        this.advance(atMs);
        return;
      }
      case "script_line":
        this.addScriptLine(m.line);
        return;
      case "tick":
        this.advance(Date.parse(m.at));
        return;
      case "session_close": {
        const s = this.sessions.get(m.sessionId);
        if (!s) return;
        const atMs = Date.parse(m.at);
        s.open = false;
        await s.stream.end();
        this.streamMinutes += s.stream.audioMinutes();
        if (m.reason !== "eof") this.events.push({ atMs, type: "disconnect", sessionId: m.sessionId });
        this.advance(atMs);
        return;
      }
    }
  }

  private openSession(session: StreamSession): void {
    const anchorMs = Date.parse(session.anchorAt);
    this.anchorMs ??= anchorMs;
    this.channels = session.audio.channels;
    this.codecIn = session.codecIn;
    if (this.sessions.size) this.events.push({ atMs: anchorMs, type: "reconnect", sessionId: session.sessionId });
    const stream = this.opts.transcriber.open(session, {
      utterance: (u) => this.addUtterance(u),
      error: (e) => this.log(`${this.key}: transcriber error: ${e.message}`),
      gap: (fromS, toS) => this.gaps.push({ fromMs: anchorMs + fromS * 1000, toMs: anchorMs + toS * 1000 }),
    });
    this.sessions.set(session.sessionId, { session, stream, anchorMs, receipts: [], open: true });
    this.advance(anchorMs);
  }

  /** Seconds on the lane axis (0 = the first session's anchor). */
  private laneS(atMs: number): number {
    return Math.round((atMs - (this.anchorMs ?? atMs)) / 1) / 1000;
  }

  private addUtterance(u: StreamUtterance): void {
    const s = this.sessions.get(u.sessionId);
    if (!s || this.anchorMs === null) return;
    const shift = (s.anchorMs - this.anchorMs) / 1000;
    const id = u.id && !this.utteranceSession.has(u.id) ? u.id : `u${this.nextUtterance}`;
    this.nextUtterance++;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    const startS = r(u.start_s + shift);
    const endS = r(u.end_s + shift);
    const base = new Date(this.anchorMs).toISOString();
    this.utterances.push({
      id,
      speaker: u.speaker,
      ...(u.speakerLabel ? { speaker_label: u.speakerLabel } : {}),
      ...(u.speakerGuessed ? { speaker_guessed: true } : {}),
      start_s: startS,
      end_s: endS,
      start_utc: addSeconds(base, startS),
      end_utc: addSeconds(base, endS),
      text: u.text,
      confidence: u.confidence,
      words: u.words.map((w) => ({ w: w.w, start_s: r(w.start_s + shift), end_s: r(w.end_s + shift), conf: w.conf })),
      ...(u.language ? { language: u.language } : {}),
    });
    this.utteranceSession.set(id, u.sessionId);
  }

  /** Simulator text mode: a typed line becomes a final utterance with no audio behind it. */
  private addScriptLine(line: ScriptLine): void {
    const s = this.sessions.get(line.sessionId);
    if (!s) return;
    const atMs = Date.parse(line.at);
    const words = line.text.split(/\s+/).filter(Boolean);
    const durS = Math.max(0.6, words.length * 0.35);
    const startS = (atMs - s.anchorMs) / 1000 - durS;
    this.addUtterance({
      sessionId: line.sessionId,
      speaker: line.speaker,
      speakerLabel: line.speaker,
      start_s: startS,
      end_s: startS + durS,
      text: line.text,
      confidence: 1,
      words: words.map((w, i) => ({ w, start_s: startS + (i * durS) / words.length, end_s: startS + ((i + 1) * durS) / words.length, conf: 1 })),
    });
    this.advance(atMs);
  }

  private meter(startMs: number, mono: Int16Array): void {
    if (this.anchorMs === null) return;
    const windowMs = (LEVEL_WINDOW_SAMPLES * 1000) / CANONICAL_RATE;
    const first = Math.floor((startMs - this.anchorMs) / windowMs);
    for (let i = 0; i < mono.length; i++) {
      const w = first + Math.floor(i / LEVEL_WINDOW_SAMPLES);
      if (w < 0) continue;
      const x = (mono[i] ?? 0) / 32768;
      this.levelSum[w] = (this.levelSum[w] ?? 0) + x * x;
      this.levelCount[w] = (this.levelCount[w] ?? 0) + 1;
    }
  }

  /** dBFS per 100 ms window on the lane axis; windows with no audio read as silence. */
  levels(): number[] {
    return Array.from({ length: this.levelSum.length }, (_, w) => {
      const n = this.levelCount[w] ?? 0;
      const rms = n ? Math.sqrt((this.levelSum[w] ?? 0) / n) : 0;
      return rms <= 1e-6 ? -120 : Math.max(-120, Math.round(20 * Math.log10(rms) * 10) / 10);
    });
  }

  transcript(): Transcript {
    const base = new Date(this.anchorMs ?? 0).toISOString();
    const first = [...this.sessions.values()][0]?.session;
    const durS = Math.max(this.laneS(this.audioEndMs || this.clockMs), this.utterances.at(-1)?.end_s ?? 0);
    return {
      transcript_id: `tr_${this.opts.runId}`,
      source_file: first?.sourceRef?.split("/").pop() ?? `${this.storeId}/${this.laneId}`,
      audio: { codec: this.codecIn, sample_rate: CANONICAL_RATE, channels: this.channels, duration_s: Math.round(durS * 1000) / 1000 },
      audio_start_utc: base,
      timestamp_source: first?.timeBasis ?? "receive_clock",
      role_source: this.opts.transcriber.name.startsWith("script") ? "script" : first && first.audio.channels > 1 ? "channel" : "diarization",
      stt: this.opts.transcriber.name,
      language: null,
      utterances: [...this.utterances].sort((a, b) => a.start_s - b.start_s),
    };
  }

  /** End of input: flush the transcriber and finish every open conversation. */
  async end(): Promise<void> {
    await this.chain;
    for (const s of this.sessions.values()) {
      if (!s.open) continue;
      s.open = false;
      await s.stream.end();
      this.streamMinutes += s.stream.audioMinutes();
    }
    await this.finalizeBatch();
  }

  get audioMinutes(): number {
    return Math.round(this.streamMinutes * 1000) / 1000;
  }

  /** Batch mode: v1 segmentation over the whole lane transcript, then each segment becomes orders. */
  private async finalizeBatch(): Promise<void> {
    const { engine } = this.opts;
    const transcript = this.transcript();
    if (!transcript.utterances.length) {
      this.segmentation = { segments: [], boundaries: [], llm_calls: 0 };
      return;
    }
    const segmentation = await segmentTranscript(transcript, { ...engine.cfg.segment, lowAudioQualityMeanConf: engine.cfg.lowAudioQualityMeanConf }, engine.judge);
    this.segmentation = segmentation;
    const levels = this.levels();
    const segs = segmentation.segments;
    for (const [i, seg] of segs.entries()) {
      const next = segs[i + 1];
      const done = await this.finalizeSegment(seg, transcript, levels, next?.start_s ?? null);
      this.collect(done);
    }
  }

  private collect(done: FinalizeResult): void {
    this.orders.push(...done.orders);
    this.sends.push(...done.sends);
    this.llm = addUsage(this.llm, done.usage);
  }

  /** Lane evidence and flags for a conversation between startS and the next one's start. */
  private evidenceFor(seg: Segment, nextStartS: number | null): { vehicle: OutcomeEvidence[]; stream: OutcomeEvidence[]; flags: Flag[] } {
    const base = this.anchorMs ?? 0;
    const startMs = base + seg.start_s * 1000;
    const endMs = base + seg.end_s * 1000;
    const windowEnd = nextStartS === null ? Number.POSITIVE_INFINITY : base + nextStartS * 1000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const vehicle = this.events
      .filter((e) => (e.type === "vehicle_departed" || e.type === "vehicle_arrived") && e.atMs > startMs && e.atMs <= windowEnd)
      .map((e): OutcomeEvidence => ({ type: "vehicle_event", event: e.type, at: iso(e.atMs) }));
    const stream = this.events
      .filter((e) => ["stream_paused", "stream_resumed", "disconnect", "reconnect"].includes(e.type) && e.atMs >= startMs && e.atMs <= Math.min(windowEnd, endMs + 30_000))
      .map((e): OutcomeEvidence => ({ type: "stream_event", event: e.type, at: iso(e.atMs), context_only: true }));
    const flags: Flag[] = [];
    const drops = this.events.filter((e) => e.type === "disconnect" && e.atMs >= startMs && e.atMs <= endMs);
    for (const d of drops) {
      const back = this.events.find((e) => e.type === "reconnect" && e.atMs > d.atMs);
      flags.push(back ? "stream_gap" : "stream_interrupted");
    }
    if (this.gaps.some((g) => g.toMs > startMs && g.fromMs < endMs)) flags.push("transcript_gap");
    return { vehicle, stream, flags: [...new Set(flags)] };
  }

  private async finalizeSegment(seg: Segment, transcript: Transcript, levels: number[], nextStartS: number | null): Promise<FinalizeResult> {
    // Audio that stops because the stream paused or the car left is not a cut-off recording.
    if (seg.truncated_end) {
      const endMs = (this.anchorMs ?? 0) + seg.end_s * 1000;
      const explained = this.events.some((e) => (e.type === "stream_paused" || e.type === "vehicle_departed") && e.atMs >= endMs - 500 && e.atMs <= endMs + 5000);
      if (explained) seg = { ...seg, truncated_end: false };
    }
    const firstId = seg.utterance_ids[0] ?? "";
    const sessionId = this.utteranceSession.get(firstId) ?? [...this.sessions.keys()][0] ?? "";
    const s = this.sessions.get(sessionId);
    const ev = this.evidenceFor(seg, nextStartS);
    const offsetS = s ? ((this.anchorMs ?? s.anchorMs) - s.anchorMs) / 1000 : 0;
    // When the conversation's first audio reached us (processing time).
    const startSample = Math.max(0, Math.round((seg.start_s + offsetS) * CANONICAL_RATE));
    const receipt = s?.receipts.find((r) => r.offset >= startSample - CANONICAL_RATE * 0.2) ?? s?.receipts[0];
    return finalizeConversation(this.opts.engine, {
      runId: this.opts.runId,
      segment: seg,
      transcript,
      session: {
        sessionId,
        storeId: this.storeId,
        laneId: this.laneId,
        timeBasis: s?.session.timeBasis ?? "receive_clock",
        sessionOffsetS: offsetS,
        source: {
          type: s?.session.sourceType ?? "hme_ws",
          codecIn: s?.session.codecIn ?? this.codecIn,
          channels: s?.session.audio.channels ?? this.channels,
          channelRoles: s?.session.audio.channelRoles ?? ["mixed"],
        },
      },
      levelsDb: levels,
      signals: { vehicle: ev.vehicle, stream: ev.stream },
      extraFlags: ev.flags,
      receivedAt: new Date(receipt?.wallMs ?? this.now()).toISOString(),
      ...(s?.session.sourceRef ? { audioFile: s.session.sourceRef } : {}),
      deliver: this.opts.deliver,
      now: this.now,
    });
  }
}

export const laneKey = (storeId: string, laneId: string) => `${storeId}:${laneId}`;
