/** LLM events -> validated OrderEvents. Code, not the model, decides what is a real id. */
import type { Catalog } from "../menu/catalog";
import type { FuzzyMatcher } from "../menu/fuzzy";
import { OrderEvent, type Utterance } from "../schemas";
import type { LlmEvent } from "./llm-schema";

export interface ValidationOutcome {
  events: OrderEvent[];
  warnings: string[];
  /** Ids that were not in the catalog and could not be fuzzy-matched. */
  unknownIds: string[];
}

const FUZZY_ACCEPT = 0.75;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

export function validateEvents(raw: LlmEvent[], utts: Utterance[], catalog: Catalog, matcher: FuzzyMatcher): ValidationOutcome {
  const byId = new Map(utts.map((u) => [u.id, u]));
  const warnings: string[] = [];
  const unknownIds: string[] = [];
  const seen = new Set<string>();
  const events: OrderEvent[] = [];

  for (const [i, e] of raw.entries()) {
    let eventId = e.event_id || `e${i + 1}`;
    if (seen.has(eventId)) eventId = `${eventId}_${i + 1}`;
    seen.add(eventId);

    const sources = e.source_utterance_ids.filter((id) => byId.has(id));
    if (sources.length < e.source_utterance_ids.length) warnings.push(`${eventId}: dropped unknown utterance ids`);

    let catalogId = e.catalog_id;
    let rawModifiers = e.modifiers;
    // ADD_MODIFIER / REMOVE_MODIFIER with the modifier in catalog_id instead of modifiers.
    if ((e.type === "ADD_MODIFIER" || e.type === "REMOVE_MODIFIER") && catalogId && catalog.modifier(catalogId)) {
      if (!rawModifiers.includes(catalogId)) rawModifiers = [...rawModifiers, catalogId];
      catalogId = null;
    }
    let rawText = e.raw_text;
    let recognition = clamp01(e.recognition_confidence);
    let candidates: OrderEvent["candidates"] = [];
    if (catalogId && !catalog.has(catalogId)) {
      const guess = matcher.candidates(`${catalogId.replace(/_/g, " ")} ${rawText ?? ""}`, 3);
      const top = guess[0];
      if (top && top.score >= FUZZY_ACCEPT) {
        warnings.push(`${eventId}: unknown id "${catalogId}" fuzzy-matched to ${top.catalog_id}`);
        catalogId = top.catalog_id;
        recognition = Math.min(recognition, top.score);
      } else {
        unknownIds.push(catalogId);
        rawText = rawText ?? catalogId;
        catalogId = null;
        candidates = guess;
      }
    }
    if (!catalogId && rawText && (e.type === "ADD" || e.type === "REPLACE")) {
      candidates = candidates.length ? candidates : matcher.candidates(rawText, 3);
    }

    const modifiers = rawModifiers.filter((m) => {
      if (catalog.modifier(m)) return true;
      warnings.push(`${eventId}: dropped unknown modifier "${m}"`);
      return false;
    });

    const readback = e.readback_items
      ?.map((r) => {
        if (catalog.has(r.catalog_id)) return r;
        const m = matcher.match(r.catalog_id.replace(/_/g, " "), FUZZY_ACCEPT);
        return m ? { ...r, catalog_id: m.catalog_id } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // Recognition can't exceed what the ASR heard: cap at the mean confidence of the source words.
    const words = sources.flatMap((id) => byId.get(id)?.words ?? []);
    if (words.length) {
      const asr = words.reduce((s, w) => s + w.conf, 0) / words.length;
      recognition = Math.min(recognition, asr);
    }

    // An event happens when its last source utterance starts (e.g. the "yes" after an offer).
    const t = sources.map((id) => byId.get(id)?.start_s ?? 0);
    events.push(
      OrderEvent.parse({
        event_id: eventId,
        type: e.type,
        target_line_ref: e.target_line_ref,
        catalog_id: catalogId,
        raw_text: rawText,
        quantity: e.quantity && e.quantity > 0 ? e.quantity : null,
        size: e.size,
        modifiers,
        slot: e.slot,
        readback_items: readback ?? null,
        amount: e.amount,
        source_utterance_ids: sources,
        recognition_confidence: round2(recognition),
        commitment_confidence: round2(clamp01(e.commitment_confidence)),
        candidates,
        t_s: t.length ? Math.max(...t) : null,
      }),
    );
  }
  return { events, warnings, unknownIds };
}
