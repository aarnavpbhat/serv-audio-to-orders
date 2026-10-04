/**
 * Step 2 gate: hand-written events for every fixture script run through
 * replay() and postprocess() and must match the expected block exactly.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replay } from "../src/build/replay";
import { compareOrders, passed } from "../src/eval/compare";
import { loadFixtureScripts } from "../src/fixtures/load";
import { postprocess } from "../src/postprocess/postprocess";
import { END_CUES, matchesAny } from "../src/segment/cues";
import type { FixtureScript } from "../src/schemas";
import { catalog, ppOptions, repoRoot, seg } from "./helpers";

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
