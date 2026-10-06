/**
 * Outcome and review rules. Pure: no I/O, no clocks.
 *
 * Status answers one question, "how did the ordering conversation end?", and is
 * set only from evidence. Silence, stream pauses and disconnects are recorded as
 * context_only and never decide completed or abandoned on their own (plan D2, D10).
 * Whether a person should check the order is the separate review flag.
 */
import type { Flag, OrderStatus, OutcomeEvidence, ReviewReason } from "../schemas";
import { CUSTOMER_DONE_CUES, DEPARTURE_SAID_CUES, END_CUES, START_CUES, firstMatch } from "../segment/cues";

/** The parts of an utterance the outcome rules read. */
export interface CueUtterance {
  id: string;
  speaker: "crew" | "customer";
  text: string;
  start_s: number;
  start_utc: string;
  /** Crew-to-crew headset chatter: never a closing or greeting cue. */
  chatter?: boolean;
}

export interface OutcomeSignals {
  utterances: CueUtterance[];
  /**
   * Vehicle events that bear on how this car left: its own vehicle_departed, or
   * the next car's vehicle_arrived (the caller leaves out the arrival that opened
   * this conversation). In a single lane, the next car at the post means this one left.
   */
  vehicle: OutcomeEvidence[];
  /** Stream pauses, disconnects and resumes during the conversation. Context only. */
  stream: OutcomeEvidence[];
  /** Long silences inside the conversation. Context only. */
  silence: OutcomeEvidence[];
}

export const emptySignals = (): OutcomeSignals => ({ utterances: [], vehicle: [], stream: [], silence: [] });

const byTime = (a: OutcomeEvidence, b: OutcomeEvidence) => Date.parse(a.at) - Date.parse(b.at);

/** Spoken cues that can support an outcome, in time order. */
export function spokenCues(utts: CueUtterance[], firstItemS: number | null): OutcomeEvidence[] {
  const out: OutcomeEvidence[] = [];
  const talk = utts.filter((u) => !u.chatter);
  talk.forEach((u, i) => {
    if (u.speaker === "crew") {
      const closing = firstMatch(u.text, END_CUES);
      if (closing && firstItemS !== null && u.start_s >= firstItemS) {
        out.push({ type: "spoken_cue", kind: "closing", cue: closing.toLowerCase(), utterance_id: u.id, at: u.start_utc });
      }
      const left = firstMatch(u.text, DEPARTURE_SAID_CUES);
      if (left) out.push({ type: "spoken_cue", kind: "departure_said", cue: left.toLowerCase(), utterance_id: u.id, at: u.start_utc });
      // A greeting after the order has started means a new car is at the post.
      const greeting = firstMatch(u.text, START_CUES);
      if (greeting && firstItemS !== null && u.start_s > firstItemS) {
        out.push({ type: "spoken_cue", kind: "next_car_greeting", cue: greeting.toLowerCase(), utterance_id: u.id, at: u.start_utc });
      }
      return;
    }
    const done = firstMatch(u.text, CUSTOMER_DONE_CUES);
    const ack = talk.slice(i + 1).find((x) => x.speaker === "crew");
    if (done && ack && firstItemS !== null && u.start_s >= firstItemS) {
      out.push({ type: "spoken_cue", kind: "customer_done", cue: done.toLowerCase(), utterance_id: u.id, at: ack.start_utc });
    }
  });
  return out.sort(byTime);
}

export interface OutcomeInput {
  /** The customer cancelled the whole order (every line removed after a cancel). */
  cancelled: boolean;
  cancelEvidence: OutcomeEvidence | null;
  /** Lines still standing (ordered or unclear). A close with nothing ordered proves nothing. */
  activeLines: number;
  firstItemS: number | null;
  signals: OutcomeSignals;
}

export interface Outcome {
  status: OrderStatus;
  evidence: OutcomeEvidence[];
}

export function decideOutcome(input: OutcomeInput): Outcome {
  const { signals } = input;
  const context = [...signals.stream, ...signals.silence].map((e) => ({ ...e, context_only: true })).sort(byTime);
  if (input.cancelled) {
    return { status: "cancelled", evidence: [...(input.cancelEvidence ? [input.cancelEvidence] : []), ...context] };
  }

  const cues = spokenCues(signals.utterances, input.activeLines > 0 ? input.firstItemS : null);
  const completion = cues.find((c) => c.kind === "closing" || c.kind === "customer_done");
  const greeting = cues.find((c) => c.kind === "next_car_greeting");
  // A vehicle event followed by more talk in this conversation did not mean the car left
  // (a missed or ghost sensor event: nobody keeps ordering from an empty lane). Talk that is
  // itself about the departure, or the next car's greeting, does not count against it.
  const aboutLeaving = new Set(cues.filter((c) => c.kind === "departure_said" || c.kind === "next_car_greeting").map((c) => c.utterance_id));
  const lastCustomerMs = Math.max(
    Number.NEGATIVE_INFINITY,
    ...signals.utterances.filter((u) => !u.chatter && !aboutLeaving.has(u.id)).map((u) => Date.parse(u.start_utc)),
  );
  const credible = (v: OutcomeEvidence) => Date.parse(v.at) >= lastCustomerMs;
  const vehicle = signals.vehicle.filter(credible);
  const doubtful = signals.vehicle.filter((v) => !credible(v)).map((v) => ({ ...v, context_only: true }));
  const departures = [
    ...vehicle.filter((v) => v.event === "vehicle_departed"),
    ...cues.filter((c) => c.kind === "departure_said"),
    // The next car's arrival counts; with a mid-order greeting it is the plan's "greeting plus vehicle event".
    ...vehicle.filter((v) => v.event === "vehicle_arrived"),
  ].sort(byTime);
  const departure = departures[0];
  const ctx = [...context, ...doubtful].sort(byTime);

  if (completion && (!departure || Date.parse(completion.at) <= Date.parse(departure.at))) {
    const supporting = vehicle.filter((v) => v.event === "vehicle_departed");
    return { status: "completed", evidence: [completion, ...supporting, ...ctx] };
  }
  if (departure) {
    const withGreeting = departure.event === "vehicle_arrived" && greeting ? [greeting] : [];
    return { status: "abandoned", evidence: [...withGreeting, departure, ...ctx] };
  }
  return { status: "undetermined", evidence: ctx };
}

export interface ReviewInput {
  status: OrderStatus;
  flags: Flag[];
  unclearItems: number;
  /** Plan D13: largest quantity on any one line, and the computed total. */
  maxQuantity: number;
  total: number;
  cap: { maxQuantity: number; maxTotal: number };
  rolesLowAgreement: boolean;
}

const FLAG_REASONS: [Flag, ReviewReason][] = [
  ["readback_mismatch", "readback_mismatch"],
  ["total_mismatch", "total_mismatch"],
  ["missing_required_slot", "missing_required_slot"],
  ["low_audio_quality", "low_audio_quality"],
  ["stream_gap", "stream_gap"],
  ["stream_interrupted", "stream_gap"],
  ["transcript_gap", "transcript_gap"],
  ["audio_dropped", "transcript_gap"],
];

export function reviewReasons(input: ReviewInput): ReviewReason[] {
  const out = new Set<ReviewReason>();
  if (input.unclearItems > 0) out.add("unclear_items");
  for (const [flag, reason] of FLAG_REASONS) if (input.flags.includes(flag)) out.add(reason);
  if (input.status === "undetermined") out.add("outcome_undetermined");
  if (input.rolesLowAgreement) out.add("roles_guessed_low_agreement");
  if (input.maxQuantity > input.cap.maxQuantity || input.total > input.cap.maxTotal) out.add("safety_cap");
  return [...out];
}
