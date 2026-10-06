/** Why an order was flagged, in plain words for the reviewer (one sentence per reason). */
import type { OrderPayload } from "@serv/pipeline";

type Name = (id: string | null) => string;

/** "We heard a shake but not which flavor": the candidates' shared word, when they have one. */
export function unclearLine(n: OrderPayload["needs_review"][number], name: Name): string {
  const names = n.candidates.slice(0, 3).map((c) => name(c.catalog_id)).filter(Boolean);
  const words = names.map((x) => x.toLowerCase().split(/\s+/));
  const shared = words[0]?.filter((w) => w.length > 2 && words.every((ws) => ws.includes(w))).at(-1);
  const heard = n.raw_text ? `"${n.raw_text}"` : "an item";
  if (shared && names.length > 1) return `We heard a ${shared} but not which one (${names.join(", ")}).`;
  if (names.length) return `We heard ${heard} but could not tell which menu item it was (closest: ${names.join(", ")}).`;
  return `We heard ${heard} but nothing on the menu matches it.`;
}

export function reviewReasonText(p: OrderPayload, name: Name): string[] {
  const out: string[] = [];
  for (const r of p.review.reasons) {
    switch (r) {
      case "unclear_items":
        out.push(...p.needs_review.map((n) => unclearLine(n, name)));
        break;
      case "readback_mismatch":
        out.push("The crew read back something different from what the customer ordered.");
        break;
      case "total_mismatch":
        out.push(`The crew said a total of $${p.totals.spoken_by_crew?.toFixed(2) ?? "?"}, but the items add up to $${p.totals.computed.toFixed(2)}.`);
        break;
      case "missing_required_slot":
        out.push("A meal is missing a choice the customer has to make (for example the drink).");
        break;
      case "low_audio_quality":
        out.push("The audio was too noisy or quiet to trust every word.");
        break;
      case "stream_gap":
        out.push("The connection dropped during the order, so part of it may be missing.");
        break;
      case "transcript_gap":
        out.push("Part of the audio was not transcribed.");
        break;
      case "outcome_undetermined":
        out.push("We could not tell how the visit ended (completed, cancelled or the car left).");
        break;
      case "roles_guessed_low_agreement":
        out.push("We could not tell which lines were the customer and which were the crew.");
        break;
      case "safety_cap":
        out.push("A quantity or the total is unusually large.");
        break;
    }
  }
  return out;
}
