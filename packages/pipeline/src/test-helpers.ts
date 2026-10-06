import path from "node:path";
import { loadCatalog } from "./menu/load";
import { FuzzyMatcher } from "./menu/fuzzy";
import { sequentialIds } from "./lib/ids";
import type { PostprocessOptions, SegmentContext } from "./postprocess/postprocess";
import { OrderEvent, type OrderEventInput } from "./schemas";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const catalog = loadCatalog(path.join(repoRoot, "menu/menu.json"));
export const matcher = new FuzzyMatcher(catalog);

export function events(list: OrderEventInput[]): OrderEvent[] {
  return list.map((e) => OrderEvent.parse(e));
}

export function ppOptions(overrides: Partial<PostprocessOptions> = {}): PostprocessOptions {
  return {
    catalog,
    matcher,
    thresholds: { recognition: 0.75, commitment: 0.75 },
    taxRate: 0,
    totalTolerance: 0.05,
    placeholders: false,
    newOrderId: sequentialIds("ord"),
    newGroupId: sequentialIds("grp"),
    ...overrides,
  };
}

export function seg(overrides: Partial<SegmentContext> = {}): SegmentContext {
  return {
    segment_id: "seg_1",
    start_s: 0,
    end_s: 60,
    utterance_ids: [],
    has_closing: true,
    truncated_start: false,
    truncated_end: false,
    non_english: false,
    low_audio_quality: false,
    crosstalk_suspected: false,
    ...overrides,
  };
}
