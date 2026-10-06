/**
 * LaneSession: everything for one store_id:lane_id. Survives reconnects (state
 * is keyed by lane, not connection). Receives canonical frames and control
 * events, feeds the streaming transcriber, keeps the lane transcript on one
 * time axis (the lane anchor), runs the conversation tracker, and turns each
 * finished conversation into orders (and later versions on reopen or late evidence).
 *
 * Batch mode (v1 segmentation once input ends) is kept only to check replay
 * parity against the old file path; the tracker is the live path.
 */
import type { Engine } from "../engine";
import { replay } from "../build/replay";
import { FuzzyExtractor } from "../extract/fuzzy-extractor";
import { addUsage, emptyUsage, type LlmUsage } from "../extract/types";
import { addSeconds } from "../ingest/start-time";
import { LEVEL_WINDOW_SAMPLES, mixdown } from "../input/pcm";
import { CANONICAL_RATE, type ControlEvent, type ScriptLine, type SourceMessage, type StreamSession } from "../input/types";
import { newId } from "../lib/ids";
import { finalizeConversation, type FinalizeResult, type RunOrder } from "../orders/finalize";
import type { BoundaryDecision, Flag, OrderEvent, OrderPayload, OutcomeEvidence, Segment, Segmentation, Transcript, Utterance } from "../schemas";
import { describe, segmentTranscript } from "../segment/segment";
import type { OutboxRow } from "../store/db";
import { LaneRecorder, type SessionEventLine } from "./recorder";
import { ConversationTracker, type TrackerAction, type TrackerDecision } from "./tracker";
import type { StreamUtterance, StreamingTranscriber, TranscriptStream } from "./types";

/** What the lane reports as it goes (live UI, logs). */
export interface DraftLine {
  name: string;
  quantity: number;
  size: string | null;
}

export type LaneUpdate =
  | { type: "session"; sessionId: string; open: boolean; at: string; codec?: string; channels?: number; sourceType?: string }
  | { type: "utterance"; utterance: Utterance }
  | { type: "interim"; text: string; sessionId: string }
  | { type: "tracker"; decision: TrackerDecision }
  | { type: "order"; payload: OrderPayload }
  | { type: "event"; event: ControlEvent["type"] | "disconnect" | "reconnect"; at: string }
  /** Tracker state and timers (lane clock), sent when they change. */
  | { type: "status"; status: ConversationTracker["status"]; clock: string; audioMinutes: number }
  /** Keyword preview of the open conversation's order (free; the real order is built at close). */
  | { type: "draft"; conversationId: string | null; lines: DraftLine[] }
  | { type: "delivery"; webhookId: string; orderId: string; version: number; status: string; attempts: number; code: number | null };

export interface LaneOptions {
  engine: Engine;
  transcriber: StreamingTranscriber;
  /** Run id for the lane's orders: fixed (replays), or per lane (the live server). */
  runId: string | ((storeId: string, laneId: string) => string);
  deliver: boolean;
  /** tracker (default): the live path. batch: v1 segmentation at end of input, for parity checks only. */
  mode?: "tracker" | "batch";
  /** Wall clock for processing times (received_at, finalized_at). */
  now?: () => number;
  log?: (msg: string) => void;
  onUpdate?: (lane: LaneSession, update: LaneUpdate) => void;
  /** Keep order audio, Deepgram messages and session events in the data store (the live server). */
  record?: boolean;
}

interface SessionState {
  session: StreamSession;
  stream: TranscriptStream;
  anchorMs: number;
  /** (sample offset, wall ms) per received frame, to date when a conversation's audio arrived. */
  receipts: { offset: number; wallMs: number }[];
  open: boolean;
  /** Tracker decisions made before this session opened (the rest are recorded with it). */
  decisionsBefore: number;
}

/** A stream or vehicle event on the lane time axis. */
interface LaneEvent {
  atMs: number;
  type: ControlEvent["type"] | "disconnect" | "reconnect";
  sessionId: string;
}

/** One car's conversation as the lane knows it, across versions. */
interface Conversation {
  id: string;
  index: number;
  /** Wall time the conversation opened (processing). */
  openedWallMs: number;
  /** First order id is minted at open (ULID); split parts and later versions reuse theirs. */
  orderIds: string[];
  groupId: string | null;
  /** Finalizations so far; each order id keeps its own version (a split part first seen on a reopen starts at 1). */
  version: number;
  versions: Map<string, number>;
  events: OrderEvent[] | null;
  statuses: string[];
  segment: Segment | null;
  finalized: FinalizeArgs | null;
  chain: Promise<void>;
}

interface FinalizeArgs {
  segment: Segment;
  vehicle: OutcomeEvidence[];
  stream: OutcomeEvidence[];
  silence: OutcomeEvidence[];
  flags: Flag[];
}

export class LaneSession {
  readonly key: string;
  readonly runId: string;
  private anchorMs: number | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly utterances: Utterance[] = [];
  private readonly byId = new Map<string, Utterance>();
  private readonly utteranceSession = new Map<string, string>();
  private readonly events: LaneEvent[] = [];
  private readonly gaps: { fromMs: number; toMs: number; dropped: boolean }[] = [];
  private readonly levelSum: number[] = [];
  private readonly levelCount: number[] = [];
  private readonly pending: Utterance[] = [];
  private readonly conversations = new Map<string, Conversation>();
  private readonly tracker: ConversationTracker;
  private queued: TrackerAction[] = [];
  private reported = 0;
  private nextUtterance = 1;
  private chain: Promise<void> = Promise.resolve();
  private clockMs = 0;
  private audioEndMs = 0;
  private channels = 1;
  private codecIn = "pcm_s16le";
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly mode: "tracker" | "batch";
  private streamMinutes = 0;
  private batchSegmentation: Segmentation | null = null;
  private readonly recorder: LaneRecorder | null;
  private lastStatus = "";
  private lastDraft = "";
  private readonly preview = new FuzzyExtractor();

  /** Every order version built, in order. */
  readonly orders: RunOrder[] = [];
  readonly sends: Promise<OutboxRow>[] = [];
  llm: LlmUsage;
  judgeCalls = 0;

  constructor(
    readonly storeId: string,
    readonly laneId: string,
    private readonly opts: LaneOptions,
  ) {
    this.key = laneKey(storeId, laneId);
    this.runId = typeof opts.runId === "string" ? opts.runId : opts.runId(storeId, laneId);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? opts.engine.log;
    this.mode = opts.mode ?? "tracker";
    this.llm = emptyUsage(opts.engine.gemini?.model ?? "none");
    const t = opts.engine.cfg.tracker;
    this.tracker = new ConversationTracker({
      closeSettleS: t.closeSettleS,
      idleTimeoutS: t.idleTimeoutS,
      reconnectGraceS: t.reconnectGraceS,
      reopenWindowS: t.reopenWindowS,
      maxConversationS: t.maxConversationS,
      segment: { ...opts.engine.cfg.segment, lowAudioQualityMeanConf: opts.engine.cfg.lowAudioQualityMeanConf },
    });
    this.recorder = opts.record
      ? new LaneRecorder({ data: opts.engine.data, storeId, laneId, keepMs: (t.maxConversationS + t.reopenWindowS + 120) * 1000, log: (m) => this.log(`${this.key}: ${m}`) })
      : null;
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

  get trackerStatus(): ConversationTracker["status"] {
    return this.tracker.status;
  }

  get decisions(): TrackerDecision[] {
    return this.tracker.decisions;
  }

  get audioMinutes(): number {
    return Math.round(this.streamMinutes * 1000) / 1000;
  }

  /** Latest version of every order. */
  get latestOrders(): RunOrder[] {
    const latest = new Map<string, RunOrder>();
    for (const o of this.orders) latest.set(o.order.order_id, o);
    return [...latest.values()];
  }

  private emit(update: LaneUpdate): void {
    this.opts.onUpdate?.(this, update);
  }

  private advance(atMs: number): void {
    if (atMs > this.clockMs) this.clockMs = atMs;
  }

  private async apply(m: SourceMessage): Promise<void> {
    switch (m.kind) {
      case "session_open":
        this.openSession(m.session);
        break;
      case "audio": {
        const s = this.sessions.get(m.frame.sessionId);
        if (!s?.open) return;
        const startMs = s.anchorMs + (m.frame.sampleOffset * 1000) / CANONICAL_RATE;
        s.receipts.push({ offset: m.frame.sampleOffset, wallMs: Date.parse(m.frame.receivedAt) });
        const mono = mixdown(m.frame.pcm);
        this.meter(startMs, mono);
        this.recorder?.audio(startMs, mono);
        s.stream.push(m.frame);
        const endMs = startMs + ((m.frame.pcm[0]?.length ?? 0) * 1000) / CANONICAL_RATE;
        this.audioEndMs = Math.max(this.audioEndMs, endMs);
        this.advance(endMs);
        break;
      }
      case "control": {
        const atMs = Date.parse(m.event.at);
        this.events.push({ atMs, type: m.event.type, sessionId: m.event.sessionId });
        this.emit({ type: "event", event: m.event.type, at: m.event.at });
        const s = this.sessions.get(m.event.sessionId);
        if (m.event.type === "stream_paused") s?.stream.pause();
        if (m.event.type === "stream_resumed") s?.stream.resume();
        await this.drain();
        this.advance(atMs);
        if (this.mode === "tracker" && isTrackerControl(m.event.type)) await this.act(this.tracker.onControl({ type: m.event.type, at: m.event.at }));
        break;
      }
      case "script_line":
        this.addScriptLine(m.line);
        break;
      case "tick":
        this.advance(Date.parse(m.at));
        break;
      case "session_close": {
        const s = this.sessions.get(m.sessionId);
        if (!s) return;
        const atMs = Date.parse(m.at);
        s.open = false;
        await s.stream.end();
        this.streamMinutes += s.stream.audioMinutes();
        this.emit({ type: "session", sessionId: m.sessionId, open: false, at: m.at });
        await this.drain();
        this.advance(atMs);
        if (m.reason !== "eof") {
          this.events.push({ atMs, type: "disconnect", sessionId: m.sessionId });
          this.emit({ type: "event", event: "disconnect", at: m.at });
          if (this.mode === "tracker") await this.act(this.tracker.onControl({ type: "disconnect", at: m.at }));
        }
        this.recordSession(m.sessionId, m.at, m.reason);
        break;
      }
    }
    await this.drain();
    await this.tickTracker();
    if (this.opts.onUpdate) await this.report();
  }

  /** Live view: tracker status when it changes, and the open order's keyword preview when its lines change. */
  private async report(): Promise<void> {
    if (this.mode !== "tracker") return;
    const status = this.tracker.status;
    const key = JSON.stringify(status);
    if (key !== this.lastStatus) {
      this.lastStatus = key;
      this.emit({ type: "status", status, clock: new Date(this.clockMs).toISOString(), audioMinutes: this.audioMinutes });
    }
    const open = this.tracker.openUtterances;
    const draftKey = `${status.conversationId}:${open.length}`;
    if (draftKey === this.lastDraft) return;
    this.lastDraft = draftKey;
    const { engine } = this.opts;
    const customer = open.filter((u) => u.speaker === "customer");
    const lines: DraftLine[] = [];
    if (customer.length) {
      const ex = await this.preview.extract({ segment: draftSegment(open), utterances: customer, catalog: engine.catalog });
      for (const l of replay(ex.events, engine.catalog).lines) {
        if (l.state === "active") lines.push({ name: l.catalog_id ? engine.catalog.name(l.catalog_id) : (l.raw_text ?? "?"), quantity: l.quantity, size: l.size });
      }
    }
    this.emit({ type: "draft", conversationId: open.length ? status.conversationId : null, lines });
  }

  private openSession(session: StreamSession): void {
    const anchorMs = Date.parse(session.anchorAt);
    this.anchorMs ??= anchorMs;
    this.channels = session.audio.channels;
    this.codecIn = session.codecIn;
    const reconnect = this.sessions.size > 0;
    const stream = this.opts.transcriber.open(session, {
      utterance: (u) => this.addUtterance(u),
      interim: (text, sessionId) => this.emit({ type: "interim", text, sessionId }),
      error: (e) => this.log(`${this.key}: transcriber error: ${e.message}`),
      gap: (fromS, toS, reason) => this.gaps.push({ fromMs: anchorMs + fromS * 1000, toMs: anchorMs + toS * 1000, dropped: reason === "dropped" }),
      ...(this.recorder ? { raw: (n: number, msgs: unknown[]) => this.recorder?.asr(session.sessionId, n, msgs, session.anchorAt, this.opts.transcriber.name) } : {}),
    });
    this.sessions.set(session.sessionId, { session, stream, anchorMs, receipts: [], open: true, decisionsBefore: this.tracker.decisions.length });
    this.advance(anchorMs);
    this.emit({ type: "session", sessionId: session.sessionId, open: true, at: session.anchorAt, codec: session.codecIn, channels: session.audio.channels, sourceType: session.sourceType });
    if (reconnect) {
      this.events.push({ atMs: anchorMs, type: "reconnect", sessionId: session.sessionId });
      this.emit({ type: "event", event: "reconnect", at: session.anchorAt });
      if (this.mode === "tracker") this.queued.push(...this.tracker.onControl({ type: "reconnect", at: session.anchorAt }));
    }
  }

  /** A closed session's control events and tracker decisions go to the data store. */
  private recordSession(sessionId: string, closedAt: string, reason: string): void {
    const s = this.sessions.get(sessionId);
    if (!this.recorder || !s) return;
    const lines: SessionEventLine[] = [
      { at: s.session.anchorAt, type: "session_open", source_type: s.session.sourceType, codec_in: s.session.codecIn, channels: s.session.audio.channels, time_basis: s.session.timeBasis },
      ...this.events.filter((e) => e.sessionId === sessionId).map((e) => ({ at: new Date(e.atMs).toISOString(), type: e.type })),
      { at: closedAt, type: "session_close", reason },
    ];
    this.recorder.events(sessionId, s.session.anchorAt, lines, this.tracker.decisions.slice(s.decisionsBefore));
  }

  /** Seconds on the lane axis (0 = the first session's anchor). */
  private laneS(atMs: number): number {
    return Math.round(atMs - (this.anchorMs ?? atMs)) / 1000;
  }

  private addUtterance(u: StreamUtterance): void {
    const s = this.sessions.get(u.sessionId);
    if (!s || this.anchorMs === null) return;
    const shift = (s.anchorMs - this.anchorMs) / 1000;
    const id = u.id && !this.byId.has(u.id) ? u.id : `u${this.nextUtterance}`;
    this.nextUtterance++;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    const startS = r(u.start_s + shift);
    const endS = r(u.end_s + shift);
    const base = new Date(this.anchorMs).toISOString();
    const utt: Utterance = {
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
    };
    this.utterances.push(utt);
    this.byId.set(id, utt);
    this.utteranceSession.set(id, u.sessionId);
    this.pending.push(utt);
    this.emit({ type: "utterance", utterance: utt });
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

  /** Final utterances go to the tracker in order; gray zones get one quick judge question. */
  private async drain(): Promise<void> {
    if (this.mode !== "tracker") {
      this.pending.length = 0;
      return;
    }
    while (this.pending.length) {
      const u = this.pending.shift() as Utterance;
      let newCar: boolean | null = null;
      const q = this.tracker.needsJudge(u);
      const judge = this.opts.engine.judge;
      if (q && judge?.newCustomerAnswer) {
        this.judgeCalls++;
        newCar = await judge.newCustomerAnswer(q.before, q.after, { timeoutMs: this.opts.engine.cfg.tracker.judgeTimeoutMs });
      }
      await this.act(this.tracker.onUtterance(u, { newCar }));
    }
  }

  /** Timers run on recording time, but never past speech that is still in progress. */
  private async tickTracker(): Promise<void> {
    if (this.mode !== "tracker" || this.anchorMs === null) return;
    let wm = this.clockMs;
    for (const s of this.sessions.values()) {
      if (!s.open) continue;
      const w = s.stream.watermarkS();
      if (Number.isFinite(w)) wm = Math.min(wm, s.anchorMs + w * 1000);
    }
    await this.act(this.tracker.onTick(new Date(wm).toISOString()));
  }

  private async act(actions: TrackerAction[]): Promise<void> {
    const all = [...this.queued.splice(0), ...actions];
    for (const d of this.tracker.decisions.slice(this.reported)) this.emit({ type: "tracker", decision: d });
    this.reported = this.tracker.decisions.length;
    for (const a of all) {
      switch (a.type) {
        case "open":
          this.conversations.set(a.conversationId, {
            id: a.conversationId,
            index: this.conversations.size,
            openedWallMs: this.now(),
            orderIds: [newId("ord")],
            groupId: null,
            version: 0,
            versions: new Map(),
            events: null,
            statuses: [],
            segment: null,
            finalized: null,
            chain: Promise.resolve(),
          });
          break;
        case "finalize":
          this.scheduleFinalize(a);
          break;
        case "reopen":
          this.log(`${this.key}: ${a.conversationId} reopened (late addition)`);
          break;
        case "late_evidence":
          this.scheduleLateEvidence(a.conversationId, a.vehicle);
          break;
      }
    }
  }

  private scheduleFinalize(a: Extract<TrackerAction, { type: "finalize" }>): void {
    const conv = this.conversations.get(a.conversationId);
    if (!conv) return;
    const utts = a.utteranceIds
      .map((id) => this.byId.get(id))
      .filter((u): u is Utterance => u !== undefined)
      .sort((x, y) => x.start_s - y.start_s);
    // Guessed roles are checked again after the LLM role pass, so a mislabelled customer is not lost.
    if (!utts.some((u) => u.speaker === "customer" || u.speaker_guessed)) {
      // A car that never spoke (or only crew lines): no order, as in v1.
      this.log(`${this.key}: ${a.conversationId} closed with no customer speech; no order`);
      return;
    }
    const durS = this.laneS(this.audioEndMs || this.clockMs);
    const segment = describe(utts, conv.index, conv.index === 0, a.trigger === "end_of_input", this.laneS(Date.parse(a.at)), durS);
    // Audio that stops because the stream paused or the car left is not a cut-off recording.
    if (segment.truncated_end && a.trigger !== "end_of_input") segment.truncated_end = false;
    const args: FinalizeArgs = { segment, vehicle: a.vehicle, stream: a.stream, silence: a.silence, flags: a.flags };
    conv.finalized = args;
    conv.segment = segment;
    const reopened = a.reopened && conv.version > 0;
    conv.chain = conv.chain.then(() => this.runFinalize(conv, args, reopened ? "reopened_late_addition" : null, null));
  }

  private scheduleLateEvidence(conversationId: string, vehicle: OutcomeEvidence[]): void {
    const conv = this.conversations.get(conversationId);
    if (!conv?.finalized) return;
    const args = { ...conv.finalized, vehicle: [...conv.finalized.vehicle, ...vehicle] };
    conv.finalized = args;
    conv.chain = conv.chain.then(() => (conv.events ? this.runFinalize(conv, args, "late_evidence", conv.events) : undefined));
  }

  /**
   * Plan D7: when roles were guessed from wording, ask the LLM once to label the
   * conversation's lines. Its answer replaces the guesses; if the two disagree
   * on many lines, the order goes to review (roles_guessed_low_agreement).
   */
  private async rolePass(seg: Segment): Promise<boolean> {
    const utts = seg.utterance_ids.map((id) => this.byId.get(id)).filter((u): u is Utterance => u !== undefined);
    if (!utts.some((u) => u.speaker_guessed) || this.rolesChecked.has(seg.utterance_ids.join())) return this.lowAgreement.has(seg.utterance_ids.join());
    this.rolesChecked.add(seg.utterance_ids.join());
    const roles = await this.opts.engine.judge?.labelLines?.(utts.map((u) => u.text));
    if (!roles) return false;
    const agree = utts.filter((u, i) => u.speaker === roles[i]).length / utts.length;
    utts.forEach((u, i) => {
      const r = roles[i];
      if (r) u.speaker = r;
    });
    const low = agree < ROLE_AGREEMENT_MIN;
    if (low) this.lowAgreement.add(seg.utterance_ids.join());
    this.log(`${this.key}: role pass on ${utts.length} guessed lines, ${Math.round(agree * 100)}% agreement`);
    return low;
  }

  private readonly rolesChecked = new Set<string>();
  private readonly lowAgreement = new Set<string>();

  private async runFinalize(conv: Conversation, args: FinalizeArgs, reason: "reopened_late_addition" | "late_evidence" | null, events: OrderEvent[] | null): Promise<void> {
    const rolesLowAgreement = events ? false : await this.rolePass(args.segment);
    if (!args.segment.utterance_ids.some((id) => this.byId.get(id)?.speaker === "customer")) {
      this.log(`${this.key}: ${conv.id} has no customer speech after the role pass; no order`);
      return;
    }
    const transcript = this.transcript();
    const sessionId = this.utteranceSession.get(args.segment.utterance_ids[0] ?? "") ?? [...this.sessions.keys()][0] ?? "";
    const s = this.sessions.get(sessionId);
    const offsetS = s ? ((this.anchorMs ?? s.anchorMs) - s.anchorMs) / 1000 : 0;
    const startSample = Math.max(0, Math.round((args.segment.start_s + offsetS) * CANONICAL_RATE));
    const receipt = s?.receipts.find((r) => r.offset >= startSample - CANONICAL_RATE * 0.2) ?? s?.receipts[0];
    // Disk guard: at 95% of the budget, audio archiving stops and the order says so.
    const paused = this.recorder !== null && this.opts.engine.data.capturePaused();
    const base = this.anchorMs ?? s?.anchorMs ?? 0;
    const recorder = this.recorder;
    const done = await finalizeConversation(this.opts.engine, {
      runId: this.runId,
      segment: args.segment,
      transcript,
      session: sessionFacts(s, sessionId, this.storeId, this.laneId, offsetS, this.codecIn, this.channels),
      levelsDb: this.levels(),
      signals: { vehicle: args.vehicle, stream: args.stream, silence: args.silence },
      extraFlags: [...args.flags, ...this.gapFlags(args.segment), ...(paused ? (["capture_paused"] as Flag[]) : [])],
      ...(recorder && !paused
        ? {
            archive: (orderId: string, version: number, p: { startedAt: string }) =>
              recorder.archive(base + args.segment.start_s * 1000 - 500, base + args.segment.end_s * 1000 + 500, { orderId, version, sessionId, startedAt: p.startedAt }),
          }
        : {}),
      rolesLowAgreement,
      receivedAt: new Date(receipt?.wallMs ?? conv.openedWallMs).toISOString(),
      ...(s?.session.sourceRef ? { audioFile: s.session.sourceRef } : {}),
      orderIds: conv.orderIds,
      groupId: conv.groupId,
      version: conv.versions,
      correctionReason: reason,
      ...(events ? { events } : {}),
      // A late vehicle event only matters if it changes how the conversation ended.
      ...(reason === "late_evidence" ? { onlyIfStatusChanges: conv.statuses } : {}),
      deliver: this.opts.deliver,
      now: this.now,
    });
    if (!done.orders.length) return;
    conv.version += 1;
    for (const o of done.orders) conv.versions.set(o.order.order_id, o.payload.order_version);
    conv.orderIds = done.orders.map((o) => o.order.order_id);
    conv.groupId = done.orders[0]?.order.group_id ?? null;
    conv.events = done.orders[0]?.events ?? conv.events;
    conv.statuses = done.orders.map((o) => o.order.status);
    this.collect(done);
    for (const o of done.orders) this.emit({ type: "order", payload: o.payload });
  }

  /** transcript_gap for provider gaps, audio_dropped when the buffer overflowed, inside this conversation. */
  private gapFlags(seg: Segment): Flag[] {
    const base = this.anchorMs ?? 0;
    const inside = this.gaps.filter((g) => g.toMs > base + seg.start_s * 1000 && g.fromMs < base + seg.end_s * 1000);
    const flags: Flag[] = [];
    if (inside.some((g) => !g.dropped)) flags.push("transcript_gap");
    if (inside.some((g) => g.dropped)) flags.push("audio_dropped");
    return flags;
  }

  /** Flag the open conversation (the endpoint reports audio_rate_exceeded this way). */
  flag(flag: Flag): void {
    if (!this.tracker.flagCurrent(flag)) this.log(`${this.key}: ${flag} with no open conversation`);
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
      transcript_id: `tr_${this.runId}`,
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

  /** Conversations as v1-style segments, plus the tracker's open decisions as boundaries. */
  segmentation(): Segmentation {
    if (this.mode === "batch") return this.batchSegmentation ?? { segments: [], boundaries: [], llm_calls: 0 };
    const transcript = this.transcript().utterances;
    const convs = [...this.conversations.values()].filter((c) => c.segment);
    const segments = convs.map((c) => c.segment as Segment);
    const boundaries: BoundaryDecision[] = convs.slice(1).map((c) => {
      const s = c.segment as Segment;
      const firstIdx = transcript.findIndex((u) => u.id === s.utterance_ids[0]);
      const open = this.tracker.decisions.find((d) => d.conversationId === c.id && d.to === "ACTIVE");
      return {
        after_index: Math.max(0, firstIdx - 1),
        score: 1,
        signals: open ? open.signals : [],
        decided_by: open?.signals.includes("judge_new_car") ? "llm" : "rules",
        is_boundary: true,
      };
    });
    return { segments, boundaries, llm_calls: this.judgeCalls };
  }

  /** End of input: flush the transcriber and finish every open conversation. */
  async end(): Promise<void> {
    await this.chain;
    const closing: string[] = [];
    for (const [id, s] of this.sessions) {
      if (!s.open) continue;
      s.open = false;
      await s.stream.end();
      this.streamMinutes += s.stream.audioMinutes();
      closing.push(id);
    }
    if (this.mode === "batch") {
      this.pending.length = 0;
      await this.finalizeBatch();
      return;
    }
    await this.drain();
    const endAt = new Date(Math.max(this.clockMs, this.audioEndMs)).toISOString();
    await this.act(this.tracker.onEnd(endAt));
    await Promise.all([...this.conversations.values()].map((c) => c.chain));
    for (const id of closing) this.recordSession(id, endAt, "end");
    await this.recorder?.flush();
  }

  private collect(done: FinalizeResult): void {
    this.orders.push(...done.orders);
    this.sends.push(...done.sends);
    for (const send of done.sends) {
      void send.then(
        (r) => this.emit({ type: "delivery", webhookId: r.webhook_id, orderId: r.order_id, version: r.order_version, status: r.status, attempts: r.attempt_count, code: r.last_status_code }),
        () => {},
      );
    }
    this.llm = addUsage(this.llm, done.usage);
  }

  /** Batch mode: v1 segmentation over the whole lane transcript, then each segment becomes orders. */
  private async finalizeBatch(): Promise<void> {
    const { engine } = this.opts;
    const transcript = this.transcript();
    if (!transcript.utterances.length) {
      this.batchSegmentation = { segments: [], boundaries: [], llm_calls: 0 };
      return;
    }
    const segmentation = await segmentTranscript(transcript, { ...engine.cfg.segment, lowAudioQualityMeanConf: engine.cfg.lowAudioQualityMeanConf }, engine.judge);
    this.batchSegmentation = segmentation;
    const segs = segmentation.segments;
    for (const [i, seg] of segs.entries()) {
      const next = segs[i + 1];
      const ev = this.batchEvidence(seg, next?.start_s ?? null);
      let segment = seg;
      if (seg.truncated_end) {
        const endMs = (this.anchorMs ?? 0) + seg.end_s * 1000;
        if (this.events.some((e) => (e.type === "stream_paused" || e.type === "vehicle_departed") && e.atMs >= endMs - 500 && e.atMs <= endMs + 5000)) segment = { ...seg, truncated_end: false };
      }
      const conv: Conversation = {
        id: `conv_${i + 1}`,
        index: i,
        openedWallMs: this.now(),
        orderIds: [newId("ord")],
        groupId: null,
        version: 0,
        versions: new Map(),
        events: null,
        statuses: [],
        segment,
        finalized: null,
        chain: Promise.resolve(),
      };
      await this.runFinalize(conv, { segment, vehicle: ev.vehicle, stream: ev.stream, silence: [], flags: ev.flags }, null, null);
    }
  }

  /** Batch mode evidence: vehicle and stream events between this conversation's start and the next one's. */
  private batchEvidence(seg: Segment, nextStartS: number | null): { vehicle: OutcomeEvidence[]; stream: OutcomeEvidence[]; flags: Flag[] } {
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
    for (const d of this.events.filter((e) => e.type === "disconnect" && e.atMs >= startMs && e.atMs <= endMs)) {
      flags.push(this.events.some((e) => e.type === "reconnect" && e.atMs > d.atMs) ? "stream_gap" : "stream_interrupted");
    }
    return { vehicle, stream, flags: [...new Set(flags)] };
  }
}

/** A stand-in segment for the draft preview (the keyword extractor reads only the utterances). */
function draftSegment(utts: Utterance[]): Segment {
  return {
    segment_id: "draft",
    index: 0,
    start_s: utts[0]?.start_s ?? 0,
    end_s: utts.at(-1)?.end_s ?? 0,
    utterance_ids: utts.map((u) => u.id),
    non_customer_ids: [],
    has_greeting: false,
    has_closing: false,
    truncated_start: false,
    truncated_end: false,
    trailing_silence_s: 0,
    language: null,
    non_english: false,
    mean_word_conf: 1,
    crosstalk_suspected: false,
  };
}

function isTrackerControl(t: ControlEvent["type"]): t is "vehicle_arrived" | "vehicle_departed" | "stream_paused" | "stream_resumed" {
  return t === "vehicle_arrived" || t === "vehicle_departed" || t === "stream_paused" || t === "stream_resumed";
}

function sessionFacts(s: SessionState | undefined, sessionId: string, storeId: string, laneId: string, offsetS: number, codecIn: string, channels: number) {
  return {
    sessionId,
    storeId,
    laneId,
    timeBasis: s?.session.timeBasis ?? ("receive_clock" as const),
    sessionOffsetS: offsetS,
    source: {
      type: s?.session.sourceType ?? ("hme_ws" as const),
      codecIn: s?.session.codecIn ?? codecIn,
      channels: s?.session.audio.channels ?? channels,
      channelRoles: s?.session.audio.channelRoles ?? ["mixed" as const],
    },
  };
}

/** Below this share of lines where the LLM agrees with the wording guesses, roles need a person's check. */
export const ROLE_AGREEMENT_MIN = 0.7;

export const laneKey = (storeId: string, laneId: string) => `${storeId}:${laneId}`;
