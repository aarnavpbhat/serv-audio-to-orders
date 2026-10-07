/**
 * Step 2 gate: hand-written events for every fixture script run through
 * replay() and postprocess() and must match the expected block exactly.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replay } from "../build/replay";
import { compareOrders, passed } from "../eval/compare";
import { loadFixtureScripts } from "../fixtures/load";
import { postprocess } from "../postprocess/postprocess";
import { emptySignals } from "../postprocess/outcome";
import { CREW_CHATTER_CUES, END_CUES, matchesAny } from "../segment/cues";
import type { FixtureScript } from "../schemas";
import { catalog, cueUtt, ppOptions, repoRoot, seg } from "../test-helpers";

const scripts = loadFixtureScripts(path.join(repoRoot, "fixtures/scripts"));
const uIndex = (id: string) => Number(id.slice(1));

/** Mimics what segmentation will derive, so the builder can be tested in isolation. */
function contextFor(script: FixtureScript, orderIdx: number) {
  const groups = script.events.map((evs) => evs.flatMap((e) => e.source_utterance_ids.map(uIndex)));
  const first = orderIdx === 0 ? 1 : Math.min(...(groups[orderIdx] ?? [1]));
  const next = groups[orderIdx + 1];
  const last = next ? Math.min(...next) - 1 : script.turns.length;
  const turns = script.turns.slice(first - 1, last);
  const isLast = orderIdx === script.events.length - 1;
  return seg({
    segment_id: `seg_${orderIdx + 1}`,
    utterance_ids: turns.map((_, i) => `u${first + i}`),
    has_closing: turns.some((t) => t.speaker === "crew" && matchesAny(t.text, END_CUES)),
    truncated_start: orderIdx === 0 && script.render.lead_silence_s === 0,
    truncated_end: isLast && script.render.tail_silence_s < 1,
    non_english: script.language !== "en",
    low_audio_quality: script.render.noise === "heavy",
    // Four seconds per turn: only the order of cues matters to the outcome rules.
    signals: {
      ...emptySignals(),
      utterances: turns.map((t, i) => ({
        ...cueUtt(`u${first + i}`, t.speaker === "customer" ? "customer" : "crew", t.text, (first + i) * 4),
        chatter: t.speaker === "crew2" || matchesAny(t.text, CREW_CHATTER_CUES),
      })),
    },
  });
}

describe("builder + post-processing on fixture events", () => {
  expect(scripts.length).toBeGreaterThanOrEqual(16);
  for (const script of scripts) {
    it(`${script.id}: ${script.title} (rows ${script.covers.join(", ")})`, () => {
      const orders = script.events.flatMap((evs, i) => postprocess(replay(evs, catalog), contextFor(script, i), ppOptions()));
      const results = compareOrders(catalog, script.expected.orders, orders);
      const diffs = results.flatMap((r, i) => r.diffs.map((d) => `order ${i + 1}: ${d}`));
      if (orders.length !== script.expected.orders.length) diffs.push(`expected ${script.expected.orders.length} orders, got ${orders.length}`);
      expect(diffs).toEqual([]);
      expect(results.every(passed)).toBe(true);
    });
  }
});
