/**
 * Keyless fallback: finds catalog names and aliases in customer utterances.
 * No corrections, no context; every hit lands in needs_review (recognition 0.6)
 * so nothing is silently treated as a confident order.
 */
import type { Catalog } from "../menu/catalog";
import { OrderEvent } from "../schemas";
import { emptyUsage, type ExtractInput, type ExtractResult, type Extractor } from "./types";

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const SIZES = ["small", "medium", "large"] as const;

interface Term {
  id: string;
  re: RegExp;
  len: number;
}

function terms(catalog: Catalog): Term[] {
  const out: Term[] = [];
  const add = (id: string, phrase: string) => {
    const p = phrase.toLowerCase().replace(/[^a-z0-9# ]/g, " ").trim();
    if (p.length < 3) return;
    out.push({ id, re: new RegExp(`\\b${p.replace(/\s+/g, "\\s+")}\\b`, "i"), len: p.length });
  };
  for (const i of catalog.menu.items) [i.name, ...i.aliases].forEach((a) => add(i.id, a));
  for (const c of catalog.menu.combos) {
    [c.name.replace(/^#\d+\s*/, ""), ...c.aliases].forEach((a) => add(c.id, a));
    add(c.id, `number ${["zero", "one", "two", "three", "four", "five", "six"][c.number] ?? c.number}`);
  }
  // Longest phrases first so "double cheeseburger" beats "cheeseburger".
  return out.sort((a, b) => b.len - a.len);
}

export class FuzzyExtractor implements Extractor {
  readonly name = "fuzzy-keyword";

  async extract({ utterances, catalog }: ExtractInput): Promise<ExtractResult> {
    const list = terms(catalog);
    const events: OrderEvent[] = [];
    for (const u of utterances.filter((x) => x.speaker === "customer")) {
      let text = ` ${u.text.toLowerCase().replace(/[^a-z0-9# ]/g, " ")} `;
      for (const t of list) {
        const m = t.re.exec(text);
        if (!m) continue;
        const before = text.slice(0, m.index).trim().split(/\s+/).slice(-2);
        const qty = before.map((w) => NUMBERS[w]).find((n) => n !== undefined) ?? 1;
        const size = SIZES.find((s) => before.includes(s)) ?? null;
        events.push(
          OrderEvent.parse({
            event_id: `e${events.length + 1}`,
            type: "ADD",
            catalog_id: t.id,
            raw_text: m[0].trim(),
            quantity: qty,
            size,
            source_utterance_ids: [u.id],
            recognition_confidence: 0.6,
            commitment_confidence: 0.8,
            t_s: u.start_s,
          }),
        );
        text = text.slice(0, m.index) + " ".repeat(m[0].length) + text.slice(m.index + m[0].length);
      }
    }
    return { events, usage: emptyUsage("none"), warnings: [], raw: null, repaired: false, fallback: false };
  }
}
