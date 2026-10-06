/**
 * Live conversation tracker: decides, as speech and events arrive, when a car's
 * conversation opens and when it is finished. Pure: no timers or I/O of its
 * own; time comes in through every call, so it is unit-testable with a fake
 * clock, like replay().
 *
 *   IDLE -> ACTIVE -> CLOSING -> FINALIZED -> IDLE (or REOPENED within the reopen window)
 *
 * v1's cue lists and gap scores are reused for "is this a new car?". Gray
 * zones are answered by the caller (the LLM yes/no question with a short
 * deadline) through needsJudge() before the utterance is passed in.
 */
import type { Flag, OutcomeEvidence, Utterance } from "../schemas";
import { CUSTOMER_DONE_CUES, END_CUES, START_CUES, matchesAny } from "../segment/cues";
import { isChatter, scoreGap, type SegmentConfig } from "../segment/segment";

export type TrackerState = "IDLE" | "ACTIVE" | "CLOSING" | "FINALIZED";

export type FinalizeTrigger =
  | "settled"
  | "vehicle_departed"
  | "next_car"
  | "idle_timeout"
  | "stream_paused"
  | "grace_expired"
  | "max_length"
  | "end_of_input";

export interface TrackerConfig {
  closeSettleS: number;
  idleTimeoutS: number;
  reconnectGraceS: number;
  reopenWindowS: number;
  maxConversationS: number;
  segment: SegmentConfig;
}

export interface TrackerControl {
  type: "vehicle_arrived" | "vehicle_departed" | "stream_paused" | "stream_resumed" | "disconnect" | "reconnect";
  at: string;
}

export type TrackerAction =
  | { type: "open"; conversationId: string; at: string; trigger: string }
  | {
      type: "finalize";
      conversationId: string;
      at: string;
      trigger: FinalizeTrigger;
      utteranceIds: string[];
      vehicle: OutcomeEvidence[];
      stream: OutcomeEvidence[];
      silence: OutcomeEvidence[];
      flags: Flag[];
      /** Reopened conversations finalize again as the next order version. */
      reopened: boolean;
    }
  | { type: "reopen"; conversationId: string; at: string; reason: "late_addition" }
  /** Evidence that arrived after finalize (a vehicle event in the reopen window). */
  | { type: "late_evidence"; conversationId: string; at: string; vehicle: OutcomeEvidence[] };

/** Every decision, with its trigger and signals, for logs and the UI. */
export interface TrackerDecision {
  at: string;
  conversationId: string | null;
  from: TrackerState;
  to: TrackerState;
  trigger: string;
  signals: string[];
}

interface Conversation {
  id: string;
  openedMs: number;
  utterances: Utterance[];
  vehicle: OutcomeEvidence[];
  stream: OutcomeEvidence[];
  flags: Set<Flag>;
  /** The customer said "that's it"; the crew's next line closes. */
  customerDone: boolean;
  /** Set on disconnect while open; cleared on reconnect. */
  heldUntilMs: number | null;
  lastSpeechMs: number;
  settleAtMs: number | null;
  reopened: boolean;
  finalizedMs: number | null;
  finalTrigger: FinalizeTrigger | null;
}

/** "Thanks", "okay", "you too": the customer answering a close, not ordering more. */
const CUSTOMER_ACK = /^(ok(ay)?|alright|all right|thanks?( you)?( so much)?|thank you|bye|cool|great|perfect|sounds good|yep|yeah|you too|see you)[.!,]?(\s+(thanks|thank you|bye|you too)[.!]?)?$/i;
/** The customer greeting at the start of their turn: a new car, not a late addition. */
const CUSTOMER_GREETING = /^(hi|hello|hey|good (morning|afternoon|evening))\b/i;

const ms = (iso: string) => Date.parse(iso);
const iso = (t: number) => new Date(t).toISOString();

export class ConversationTracker {
  private state: TrackerState = "IDLE";
  private current: Conversation | null = null;
  /** The last finalized conversation, while its reopen window is open. */
  private last: Conversation | null = null;
  /** Crew lines heard before a conversation opened (a greeting may follow). */
  private preroll: Utterance[] = [];
  private nextId = 1;
  private arrivedSinceFinalize = false;
  readonly decisions: TrackerDecision[] = [];

  constructor(
    private readonly cfg: TrackerConfig,
    private readonly newId: (n: number) => string = (n) => `conv_${n}`,
  ) {}

  get status(): { state: TrackerState; conversationId: string | null; timers: Record<string, string | null> } {
    const c = this.current;
    return {
      state: this.state,
      conversationId: c?.id ?? (this.state === "FINALIZED" ? (this.last?.id ?? null) : null),
      timers: {
        settle: c?.settleAtMs ? iso(c.settleAtMs) : null,
        idle: c && !c.heldUntilMs ? iso(c.lastSpeechMs + this.cfg.idleTimeoutS * 1000) : null,
        grace: c?.heldUntilMs ? iso(c.heldUntilMs) : null,
        reopen: this.state === "FINALIZED" && this.last?.finalizedMs ? iso(this.last.finalizedMs + this.cfg.reopenWindowS * 1000) : null,
        max: c ? iso(c.openedMs + this.cfg.maxConversationS * 1000) : null,
      },
    };
  }

  /**
   * Before onUtterance: the gap score if this utterance is a gray-zone "new car?"
   * question (the caller asks the judge, with a deadline, and passes the answer in).
   */
  needsJudge(u: Utterance): { score: number; before: Utterance[]; after: Utterance[] } | null {
    const c = this.current;
    if (!c || this.state !== "ACTIVE" || isChatter(u)) return null;
    const talk = c.utterances.filter((x) => !isChatter(x));
    const { score } = this.gapScore(talk, u);
    if (score >= this.cfg.segment.highThreshold || score < this.cfg.segment.lowThreshold) return null;
    return { score, before: talk.slice(-3), after: [u] };
  }

  onUtterance(u: Utterance, judged: { newCar: boolean | null } = { newCar: null }): TrackerAction[] {
    const out = this.onTick(u.start_utc);
    const at = u.start_utc;
    const chatter = isChatter(u);
    const crewStart = u.speaker === "crew" && matchesAny(u.text, START_CUES);

    if (this.state === "FINALIZED" && this.last) {
      const late = u.speaker === "customer" && !chatter && !crewStart && !this.arrivedSinceFinalize && !CUSTOMER_GREETING.test(u.text.trim()) && !CUSTOMER_ACK.test(u.text.trim());
      if (late) {
        // "Oh wait, add a water": the same car, within the window, before anyone new.
        const c = this.last;
        this.last = null;
        this.current = c;
        c.reopened = true;
        c.finalizedMs = null;
        c.utterances.push(...this.takePreroll(), u);
        c.lastSpeechMs = ms(u.end_utc);
        c.settleAtMs = ms(u.end_utc) + this.cfg.closeSettleS * 1000;
        this.move("CLOSING", c.id, at, "late_addition", ["customer_spoke_within_reopen_window"]);
        out.push({ type: "reopen", conversationId: c.id, at, reason: "late_addition" });
        return out;
      }
      if (u.speaker === "crew" && !crewStart) {
        this.preroll.push(u);
        return out;
      }
      this.endWindow(at);
    }

    if (this.state === "IDLE") {
      if (chatter) return out;
      if (u.speaker === "crew" && !crewStart) {
        this.preroll.push(u);
        return out;
      }
      out.push(this.open(at, crewStart ? "crew_greeting" : "customer_speech", u));
      return out;
    }

    const c = this.current;
    if (!c) return out;

    // A new car? Greeting after a close, rules on the gap, or the judge's answer.
    if (!chatter) {
      const talk = c.utterances.filter((x) => !isChatter(x));
      const { score, signals } = this.gapScore(talk, u);
      const closingGreeting = this.state === "CLOSING" && crewStart;
      const ruled = score >= this.cfg.segment.highThreshold;
      const judgedNew = judged.newCar === true;
      const fallback = judged.newCar === null && score >= this.cfg.segment.lowThreshold && score >= 0.5;
      if (closingGreeting || ruled || judgedNew || (this.state === "ACTIVE" && fallback)) {
        const why = closingGreeting ? "next_car_greeting" : judgedNew ? "judge_new_car" : "gap_score";
        out.push(this.finalize(at, "next_car", [why, ...signals, `score_${score}`]));
        out.push(this.open(at, crewStart ? "crew_greeting" : "customer_speech", u));
        return out;
      }
    }

    c.utterances.push(u);
    if (chatter) return out;
    if (u.speaker === "customer") {
      c.lastSpeechMs = ms(u.end_utc);
      if (matchesAny(u.text, CUSTOMER_DONE_CUES)) c.customerDone = true;
      if (this.state === "CLOSING") {
        if (CUSTOMER_ACK.test(u.text.trim()) || matchesAny(u.text, CUSTOMER_DONE_CUES)) {
          c.settleAtMs = ms(u.end_utc) + this.cfg.closeSettleS * 1000;
        } else {
          c.settleAtMs = null;
          this.move("ACTIVE", c.id, at, "customer_ordering", ["more_ordering_after_close"]);
        }
      }
      return out;
    }

    // Crew line.
    c.lastSpeechMs = ms(u.end_utc);
    const hasCustomer = c.utterances.some((x) => x.speaker === "customer");
    const endCue = matchesAny(u.text, END_CUES);
    if (hasCustomer && (endCue || c.customerDone)) {
      c.settleAtMs = ms(u.end_utc) + this.cfg.closeSettleS * 1000;
      if (this.state === "ACTIVE") this.move("CLOSING", c.id, at, endCue ? "crew_end_cue" : "customer_done_acknowledged", [endCue ? "end_cue" : "customer_done"]);
      c.customerDone = false;
    }
    return out;
  }

  onControl(e: TrackerControl): TrackerAction[] {
    const out = this.onTick(e.at);
    const t = ms(e.at);
    const c = this.current;
    switch (e.type) {
      case "vehicle_arrived": {
        if (this.state === "FINALIZED" && this.last) {
          // The next car is at the post: the last one has left (late evidence for it).
          out.push({ type: "late_evidence", conversationId: this.last.id, at: e.at, vehicle: [{ type: "vehicle_event", event: e.type, at: e.at }] });
          this.arrivedSinceFinalize = true;
          this.endWindow(e.at);
        }
        if (this.state === "IDLE") {
          // Vehicle events win when present: the conversation opens on arrival.
          out.push(this.open(e.at, "vehicle_arrived"));
          return out;
        }
        // Arrival while a conversation is open: recorded; it counts only if no more talk follows.
        if (c && c.openedMs !== t) c.vehicle.push({ type: "vehicle_event", event: e.type, at: e.at });
        return out;
      }
      case "vehicle_departed": {
        if (c && (this.state === "ACTIVE" || this.state === "CLOSING")) {
          c.vehicle.push({ type: "vehicle_event", event: e.type, at: e.at });
          out.push(this.finalize(e.at, "vehicle_departed", ["vehicle_departed"]));
          return out;
        }
        if (this.state === "FINALIZED" && this.last) {
          out.push({ type: "late_evidence", conversationId: this.last.id, at: e.at, vehicle: [{ type: "vehicle_event", event: e.type, at: e.at }] });
        }
        return out;
      }
      case "stream_paused": {
        if (c) {
          c.stream.push({ type: "stream_event", event: e.type, at: e.at, context_only: true });
          // A pause closes the conversation but never sets the outcome on its own (D10).
          out.push(this.finalize(e.at, "stream_paused", ["stream_paused"]));
        }
        return out;
      }
      case "stream_resumed":
        c?.stream.push({ type: "stream_event", event: e.type, at: e.at, context_only: true });
        return out;
      case "disconnect": {
        if (c && !c.heldUntilMs) {
          c.stream.push({ type: "stream_event", event: "disconnect", at: e.at, context_only: true });
          c.heldUntilMs = t + this.cfg.reconnectGraceS * 1000;
          this.decisions.push({ at: e.at, conversationId: c.id, from: this.state, to: this.state, trigger: "disconnect_hold", signals: [`grace_${this.cfg.reconnectGraceS}s`] });
        }
        return out;
      }
      case "reconnect": {
        if (c?.heldUntilMs) {
          c.heldUntilMs = null;
          c.flags.add("stream_gap");
          c.stream.push({ type: "stream_event", event: "reconnect", at: e.at, context_only: true });
          // Silence while disconnected is not the customer's silence.
          c.lastSpeechMs = Math.max(c.lastSpeechMs, t);
          if (c.settleAtMs) c.settleAtMs = Math.max(c.settleAtMs, t + this.cfg.closeSettleS * 1000);
          this.decisions.push({ at: e.at, conversationId: c.id, from: this.state, to: this.state, trigger: "reconnected", signals: ["stream_gap"] });
        }
        return out;
      }
    }
  }

  /** A live-path flag for the open conversation (audio rate exceeded, audio dropped). */
  flagCurrent(flag: Flag): boolean {
    if (!this.current) return false;
    this.current.flags.add(flag);
    return true;
  }

  /** Timers: settle, idle, grace, reopen window, hard cap. */
  onTick(now: string): TrackerAction[] {
    const t = ms(now);
    const out: TrackerAction[] = [];
    const c = this.current;
    if (c) {
      if (c.heldUntilMs) {
        if (t >= c.heldUntilMs) {
          c.flags.add("stream_interrupted");
          out.push(this.finalize(iso(c.heldUntilMs), "grace_expired", ["no_reconnect_within_grace"]));
        }
      } else if (c.settleAtMs && t >= c.settleAtMs && this.state === "CLOSING") {
        out.push(this.finalize(iso(c.settleAtMs), "settled", ["no_customer_speech_after_close"]));
      } else if (t >= c.lastSpeechMs + this.cfg.idleTimeoutS * 1000) {
        out.push(this.finalize(iso(c.lastSpeechMs + this.cfg.idleTimeoutS * 1000), "idle_timeout", [`silence_${this.cfg.idleTimeoutS}s`]));
      } else if (t >= c.openedMs + this.cfg.maxConversationS * 1000) {
        out.push(this.finalize(now, "max_length", [`longer_than_${this.cfg.maxConversationS}s`]));
      }
    }
    if (this.state === "FINALIZED" && this.last?.finalizedMs && t >= this.last.finalizedMs + this.cfg.reopenWindowS * 1000) this.endWindow(now);
    return out;
  }

  /** End of input: finish whatever is open. */
  onEnd(now: string): TrackerAction[] {
    const out = this.onTick(now);
    if (this.current) out.push(this.finalize(now, "end_of_input", ["end_of_input"]));
    if (this.state === "FINALIZED") this.endWindow(now);
    return out;
  }

  // ------------------------------------------------------------ internals

  private gapScore(talk: Utterance[], u: Utterance): { score: number; signals: string[] } {
    const window = [...talk.slice(-2), u];
    const base = scoreGap(window, window.length - 2, this.cfg.segment);
    // A car arrived since the last line and this line greets it: boundaries follow vehicle events.
    // An arrival with no greeting (a ghost or a car in the next lane) does not split the order.
    const lastEnd = talk.length ? ms((talk[talk.length - 1] as Utterance).end_utc) : 0;
    const arrived = this.current?.vehicle.some((v) => v.event === "vehicle_arrived" && ms(v.at) >= lastEnd && ms(v.at) <= ms(u.start_utc));
    const greets = (u.speaker === "crew" && matchesAny(u.text, START_CUES)) || (u.speaker === "customer" && CUSTOMER_GREETING.test(u.text.trim()));
    if (!arrived || !greets) return base;
    return { score: Math.min(1, Math.round((base.score + 0.4) * 100) / 100), signals: [...base.signals, "vehicle_arrived"] };
  }

  private takePreroll(): Utterance[] {
    const p = this.preroll;
    this.preroll = [];
    return p;
  }

  private open(at: string, trigger: string, u?: Utterance): TrackerAction {
    const id = this.newId(this.nextId++);
    const t = ms(at);
    // Crew lines from the last 10 s before the open belong to this car.
    const preroll = this.takePreroll().filter((p) => t - ms(p.end_utc) <= 10_000);
    this.current = {
      id,
      openedMs: t,
      utterances: [...preroll, ...(u ? [u] : [])],
      vehicle: [],
      stream: [],
      flags: new Set(),
      customerDone: false,
      heldUntilMs: null,
      lastSpeechMs: u ? ms(u.end_utc) : t,
      settleAtMs: null,
      reopened: false,
      finalizedMs: null,
      finalTrigger: null,
    };
    if (u?.speaker === "customer" && matchesAny(u.text, CUSTOMER_DONE_CUES)) this.current.customerDone = true;
    this.arrivedSinceFinalize = false;
    this.move("ACTIVE", id, at, trigger, [trigger]);
    return { type: "open", conversationId: id, at, trigger };
  }

  private finalize(at: string, trigger: FinalizeTrigger, signals: string[]): TrackerAction {
    const c = this.current as Conversation;
    const t = ms(at);
    const silence: OutcomeEvidence[] =
      trigger === "idle_timeout" ? [{ type: "silence", at: iso(c.lastSpeechMs), duration_s: this.cfg.idleTimeoutS, context_only: true }] : [];
    c.finalizedMs = t;
    c.finalTrigger = trigger;
    c.settleAtMs = null;
    c.heldUntilMs = null;
    this.current = null;
    this.last = c;
    this.move("FINALIZED", c.id, at, trigger, signals);
    return {
      type: "finalize",
      conversationId: c.id,
      at,
      trigger,
      utteranceIds: c.utterances.map((u) => u.id),
      vehicle: [...c.vehicle],
      stream: [...c.stream],
      silence,
      flags: [...c.flags],
      reopened: c.reopened,
    };
  }

  private endWindow(at: string): void {
    if (this.state !== "FINALIZED") return;
    this.last = null;
    this.move("IDLE", null, at, "reopen_window_closed", []);
  }

  private move(to: TrackerState, conversationId: string | null, at: string, trigger: string, signals: string[]): void {
    this.decisions.push({ at, conversationId, from: this.state, to, trigger, signals });
    this.state = to;
  }
}
