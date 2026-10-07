/** Phrase cues used by segmentation and crew/customer role assignment. */

export const START_CUES: RegExp[] = [
  /\bwelcome to\b/i,
  /\bwhat can i (get|do) (started )?(for you|you)\b/i,
  /\bwhat can i get\b/i,
  /\border when(ever)? you'?re ready\b/i,
  /\bgo ahead( whenever| when)?\b/i,
  /\bwhat (would|will|do) you (like|want|have)\b/i,
  /\bhow can i help you\b/i,
];

export const END_CUES: RegExp[] = [
  /\bpull (forward|around|up)\b/i,
  /\byour total (is|comes to|will be)\b/i,
  /\bthat'?(ll| will) be \$?\d/i,
  /\bthat'?s \$\d/i,
  /\bsee you at the (next )?window\b/i,
  /\bhave a (good|great|nice) (one|day|night|evening)\b/i,
  /\bat the (first |second |next )?window\b/i,
];

/** Crew-to-crew chatter heard on the headset; never part of the customer's order. */
export const CREW_CHATTER_CUES: RegExp[] = [
  /\bneed (more |another )?\w+( \w+)? on (one|two|three|four|1|2|3|4)\b/i,
  /\bdrop (another |a |some )?(basket|fries|nuggets)\b/i,
  /\b(behind you|heard|corner)\b[.!]?$/i,
  /\bon the grill\b/i,
  /\bcan (someone|somebody) (grab|get|cover|help)\b/i,
  /\bfries (are )?down\b/i,
];

/** Things only the crew says. Used to tell crew from customer when there are no channels. */
export const CREW_ROLE_CUES: RegExp[] = [
  ...START_CUES,
  ...END_CUES,
  /\banything else\b/i,
  /\bwould you like to (make|add|try)\b/i,
  /\bwant to make (it|that) a (meal|combo)\b/i,
  /\bwe'?re (all )?out of\b/i,
  /\bwhat (size|drink|kind)\b/i,
  /\bwhich drink\b/i,
];

/** "Sorry, can you start over?" keeps the same order. */
export const RESTART_CUES: RegExp[] = [/\bstart over\b/i, /\bfrom the (top|beginning)\b/i, /\bsay that again\b/i];

export const matchesAny = (text: string, cues: RegExp[]): boolean => cues.some((r) => r.test(text));

export function cueHits(text: string, cues: RegExp[]): number {
  return cues.reduce((n, r) => n + (r.test(text) ? 1 : 0), 0);
}

/** The customer saying they are done ("that's it"). Counts as a close only when the crew answers. */
export const CUSTOMER_DONE_CUES: RegExp[] = [
  /\bthat'?s (it|all|everything)\b/i,
  /\bthat('?ll| will) be (it|all)\b/i,
  /\bnothing else\b/i,
];

/** The crew saying the car left before finishing: evidence of abandonment. */
export const DEPARTURE_SAID_CUES: RegExp[] = [
  /\b(they|he|she|the car|that car)( just)? (drove|pulled|took) (off|away)\b/i,
  /\b(they|he|she)( just)? left\b/i,
  /\bdrove off\b/i,
];

/** First regex match in the text, for evidence records. */
export function firstMatch(text: string, cues: RegExp[]): string | null {
  for (const r of cues) {
    const m = r.exec(text);
    if (m) return m[0];
  }
  return null;
}
