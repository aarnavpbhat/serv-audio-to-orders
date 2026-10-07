import { CREW_CHATTER_CUES, CREW_ROLE_CUES, cueHits, matchesAny } from "../segment/cues";

export interface RoleAssignment {
  crew: Set<string>;
  /** True when the cue scores could not separate crew from customer. */
  ambiguous: boolean;
  scores: Record<string, number>;
}

/**
 * Diarization gives speaker numbers, not roles. The speaker who greets, asks
 * "anything else" or reads a total is crew. A second crew voice that only
 * says headset chatter ("need fries on two") is crew too.
 */
export function assignRoles(utterances: { label: string; text: string }[]): RoleAssignment {
  const scores: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const chatterOnly: Record<string, boolean> = {};
  for (const u of utterances) {
    scores[u.label] = (scores[u.label] ?? 0) + cueHits(u.text, CREW_ROLE_CUES);
    counts[u.label] = (counts[u.label] ?? 0) + 1;
    chatterOnly[u.label] = (chatterOnly[u.label] ?? true) && matchesAny(u.text, CREW_CHATTER_CUES);
  }
  const ranked = Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const crew = new Set<string>();
  const top = ranked[0];
  const second = ranked[1];
  const ambiguous = top === undefined || (scores[top] ?? 0) === 0 || (second !== undefined && scores[top] === scores[second]);
  if (top !== undefined && (scores[top] ?? 0) > 0) crew.add(top);
  for (const label of ranked) if (chatterOnly[label]) crew.add(label);
  return { crew, ambiguous, scores };
}

/**
 * True when diarization put (nearly) every line under one voice, so speaker
 * labels say nothing about who is crew. Mono drive-thru audio does this often.
 */
export function diarizationCollapsed(labels: string[]): boolean {
  if (labels.length < 2) return false;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return Math.max(...counts.values()) / labels.length >= 0.9;
}

/** Things only the customer says. Used when diarization hears a single voice. */
export const CUSTOMER_ROLE_CUES: RegExp[] = [
  /\b(can|could|may) (i|we) (get|have|grab|do|try)\b/i,
  /\b(let me|lemme) (get|have|grab|do|try)\b/i,
  /\bi'?ll (just )?(have|get|take|do|try)\b/i,
  /\bi('d| would) like\b/i,
  /\bi (want|need)\b/i,
  /\bpay separately\b/i,
  /\b(first|second|next|other|my) order is\b/i,
  /\b(never ?mind|we'?re good|i'?m good)\b/i,
  /\bthat'?s (it|all|everything)\b/i,
  /\b(scratch|cancel|drop|remove|take off) (the|that|my)\b/i,
  /(^|[.!?,]\s+)(and |also |plus )?(add|give me|gimme)\b/i,
  /^actually\b/i,
  /\bsame (thing|again) for\b/i,
  /^(one|two|both) with(out| no)\b/i,
  /^(and|also|plus) (a|an|the|one|two|three|four|\d+) [^$]*\.$/i,
  /\bhow (much|big|many)\b/i,
  /\bdo you (have|guys have)\b/i,
  /\b(quiero|dame|por favor)\b/i,
];

/** "Okay, large Sprite." The crew confirming what they heard, not just "okay". */
const CREW_CONFIRM = /^(okay|ok|alright|all right|got it|sure)[.,!]?\s+\S/i;
/** A dollar amount: totals are read by the crew. */
const PRICE = /\$\d/;

export interface TurnLine {
  text: string;
  start_s: number;
  end_s: number;
}

/**
 * Role per line from wording and turn-taking, for when diarization puts every
 * voice under one label. Cue phrases decide first; the rest follow the turn:
 * a line that continues an unfinished one ("a medium, uh," / "shake?") keeps
 * the speaker, anything else alternates (which also makes a readback crew).
 */
export function inferTurnRoles(lines: TurnLine[]): ("crew" | "customer")[] {
  const out: ("crew" | "customer" | null)[] = lines.map((l) => {
    const crew = cueHits(l.text, CREW_ROLE_CUES) + (CREW_CONFIRM.test(l.text) ? 1 : 0) + (PRICE.test(l.text) ? 1 : 0) + (matchesAny(l.text, CREW_CHATTER_CUES) ? 2 : 0);
    const customer = cueHits(l.text, CUSTOMER_ROLE_CUES);
    return crew > customer ? "crew" : customer > crew ? "customer" : null;
  });
  const flip = (r: "crew" | "customer") => (r === "crew" ? "customer" : "crew");
  const continues = (i: number) => {
    const prev = lines[i - 1];
    return !!prev && !/[.?!]$/.test(prev.text.trim()) && lines[i]!.start_s - prev.end_s < 1.5;
  };

  // Forward from each decided line, then backward for any leading undecided lines.
  for (let i = 1; i < lines.length; i++) {
    const prev = out[i - 1];
    if (out[i] === null && prev) out[i] = continues(i) ? prev : flip(prev);
  }
  for (let i = lines.length - 2; i >= 0; i--) {
    const next = out[i + 1];
    if (out[i] === null && next) out[i] = continues(i + 1) ? next : flip(next);
  }
  return out.map((r) => r ?? "crew");
}
