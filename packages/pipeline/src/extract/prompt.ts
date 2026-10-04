import type { Catalog } from "../menu/catalog";
import type { Utterance } from "../schemas";

export const PROMPT_VERSION = "extract-v4";

export const SYSTEM_PROMPT = `You convert one drive-thru conversation into ORDER EVENTS. You do not write the final order; code replays your events against the menu, so be literal and use the exact ids from the menu.

EVENT TYPES
- ADD: customer orders an item or meal. New line; its event_id is the line reference.
- REMOVE: customer drops a line ("scratch the fries"). Set target_line_ref; quantity if only some units go.
- CHANGE_QTY: "make that two". quantity = new total for the line.
- CHANGE_SIZE: "actually, large".
- ADD_MODIFIER / REMOVE_MODIFIER: "no pickles" / "pickles are fine". quantity = how many units it applies to when fewer than the line ("two burgers, one with no pickles" = ADD quantity 2, then ADD_MODIFIER quantity 1).
- REPLACE: "Sprite instead of Coke". target_line_ref = the Coke line, catalog_id = sprite. For a meal's drink or side, target the meal line and set slot.
- SET_COMBO_SLOT: choose a meal's side or drink ("#2 with a Sprite"). target_line_ref = the meal line, slot = "drink" or "side". If the customer says they want no drink, catalog_id null and raw_text "no drink".
- DUPLICATE_LINE: "same thing for her". target_line_ref = line to copy: the most recently ordered line unless they name another ("same meal for him" = the meal).
- DECLINE_UPSELL: crew offers something, customer says no. catalog_id = what was offered (for "make it a meal", the meal id whose entree is on the order).
- INQUIRE: customer only asks about an item ("how big is the large?").
- OUT_OF_STOCK: crew says an item is unavailable. target_line_ref if it was ordered.
- SPLIT_ORDER: separate payments. Emit it where the next separately paid order begins. If the split is asked after ordering, set target_line_ref to the first line of the second order.
- CANCEL_ORDER: customer cancels everything ("never mind").
- READBACK: crew repeats the order and/or says the total. readback_items = exactly what the crew said (their sizes and quantities, even if wrong). amount = spoken total in dollars.

RULES
1. Only the customer can add items. A crew suggestion becomes an ADD only if the customer accepts it; cite both utterances. Speaker labels can be wrong: a label ending in "?" is a guess, so decide who said each line from what it says (crew greet, repeat the order back, ask "anything else", read totals; customers order).
2. Questions about an item are INQUIRE with its catalog_id, not orders ("how big is the large fries?" = INQUIRE fries, size large). Ask-then-order of the same item is INQUIRE then ADD.
3. Use catalog ids from the MENU only. If you cannot tell which item was said, emit ADD with catalog_id null, raw_text = the customer's words, recognition_confidence <= 0.4. Commitment is separate: a firm order of an item nobody could make out ("yeah, that one") is still 0.9 or above.
4. Meals: "number two", "#2", "the two", "a two meal" = combo_2. "two number threes" = combo_3 quantity 2. "number two, three of them" = combo_2 quantity 3. The meal size applies to the meal line (set size on the ADD or a CHANGE_SIZE on it).
5. Sizes: small, medium or large only ("kid's" = small, "regular" = medium). Leave size null when none was said.
6. Hesitation then backing off ("maybe a cookie... nah") is an ADD with commitment_confidence <= 0.3. Firm orders are 0.9 or above.
7. recognition_confidence reflects how sure you are about the item identity given possible transcription errors. Lower it for odd words, misheard names or [inaudible].
8. Map misheard or non-English names to the closest catalog item ("hamburguesa con queso doble" = dbl_cheese, "papas" = fries). Keep raw_text with the original words.
9. Crew lines are evidence only (readbacks, totals, out of stock, offers, confirming what they heard).
10. Every event lists source_utterance_ids. Events are in conversation order with ids e1, e2, e3...
11. Do not invent items that were never said. Do not output events for small talk.`;

function lowConfWords(u: Utterance): string {
  const low = u.words.filter((w) => w.low_conf).map((w) => w.w);
  return low.length ? `  {unclear: ${low.join(", ")}}` : "";
}

export function formatUtterances(utts: Utterance[]): string {
  return utts.map((u) => `${u.id} [${u.speaker}${u.speaker_guessed ? "?" : ""}] ${u.text}${lowConfWords(u)}`).join("\n");
}

export function buildUserPrompt(catalog: Catalog, utts: Utterance[]): string {
  return `MENU\n${catalog.promptCatalog()}\n\nCONVERSATION (utterance id, speaker, text)\n${formatUtterances(utts)}\n\nReturn the events JSON.`;
}

export function repairPrompt(previous: string, error: string): string {
  return `Your previous answer was invalid.\nError: ${error}\nPrevious answer:\n${previous.slice(0, 6000)}\n\nReturn corrected JSON that matches the schema and uses only ids from the MENU.`;
}

export const BOUNDARY_PROMPT = `You read a drive-thru recording transcript. Decide whether a NEW customer (a different car) starts speaking at the marked point. Answer with JSON {"new_customer": true|false}.`;

export const ROLE_PROMPT = `You read lines from a drive-thru recording, grouped by speaker. The crew member greets, takes the order, repeats it back and reads totals. Customers order food. Return JSON {"crew_speaker": "<speaker label>"} naming the crew member.`;
