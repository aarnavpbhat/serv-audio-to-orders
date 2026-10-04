import Fuse from "fuse.js";
import type { Candidate } from "../schemas";
import type { Catalog } from "./catalog";

interface Entry {
  id: string;
  term: string;
}

const STOPWORDS = new Set(["a", "an", "the", "and", "uh", "um", "with", "of", "some", "can", "i", "get", "please", "me", "like", "id", "i'd"]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9#\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(" ");
}

/** Maps misheard item names to catalog ids through names and aliases. */
export class FuzzyMatcher {
  private readonly fuse: Fuse<Entry>;

  constructor(private readonly catalog: Catalog) {
    const entries: Entry[] = [];
    for (const i of catalog.menu.items) {
      entries.push({ id: i.id, term: normalize(i.name) });
      for (const a of i.aliases) entries.push({ id: i.id, term: normalize(a) });
    }
    for (const c of catalog.menu.combos) {
      entries.push({ id: c.id, term: normalize(c.name) });
      for (const a of c.aliases) entries.push({ id: c.id, term: normalize(a) });
    }
    this.fuse = new Fuse(entries, { keys: ["term"], includeScore: true, threshold: 0.4, ignoreLocation: true });
  }

  /** Top candidates with a 0..1 similarity score (1 = exact). */
  candidates(text: string, limit = 3): Candidate[] {
    const q = normalize(text);
    if (!q) return [];
    const best = new Map<string, number>();
    const consider = (query: string, weight: number) => {
      for (const r of this.fuse.search(query)) {
        const score = (1 - (r.score ?? 1)) * weight;
        if (score > (best.get(r.item.id) ?? 0)) best.set(r.item.id, score);
      }
    };
    consider(q, 1);
    // Single words carry signal when the rest of the phrase is garbled ("[inaudible] shake").
    for (const w of q.split(" ")) if (w.length >= 4) consider(w, 0.8);
    return [...best.entries()]
      .filter(([, score]) => score >= 0.4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([catalog_id, score]) => ({ catalog_id, score: Math.round(score * 100) / 100 }));
  }

  /** Best single match above a minimum score, or null. */
  match(text: string, minScore = 0.6): Candidate | null {
    const [top] = this.candidates(text, 1);
    return top && top.score >= minScore ? top : null;
  }

  get menuCatalog(): Catalog {
    return this.catalog;
  }
}
