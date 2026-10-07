/**
 * Eval ceiling for fixture audio: returns the hand-written events from the
 * fixture script instead of asking an LLM. With the script transcriber this
 * checks segmentation, the builder, post-processing and the eval scoring
 * end to end; any failure there is a pipeline bug, not a model error.
 */
import path from "node:path";
import { loadFixtureScripts } from "../fixtures/load";
import { OrderEvent, type FixtureScript } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import { emptyUsage, type ExtractInput, type ExtractResult, type Extractor } from "./types";

export class OracleExtractor implements Extractor {
  readonly name = "oracle/fixture-events";
  private scripts: Map<string, FixtureScript> | null = null;

  constructor(private readonly fixturesDir: string) {}

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const empty: ExtractResult = { events: [], usage: emptyUsage("none"), warnings: [], raw: null, repaired: false, fallback: false };
    if (!input.audioFile) return { ...empty, warnings: ["oracle extractor needs fixture audio"] };
    const timeline = loadTimeline(input.audioFile);
    if (!timeline) return { ...empty, warnings: ["no fixture timeline for this file"] };
    this.scripts ??= new Map(loadFixtureScripts(path.join(this.fixturesDir, "scripts")).map((s) => [s.id, s]));

    // Map (fixture, turn) -> utterance in this file, then keep the event groups that fall in this segment.
    const inSegment = new Set(input.segment.utterance_ids);
    const byTurn = new Map(timeline.utterances.map((u) => [`${u.fixture_id}#${u.turn_index}`, u.id]));
    const start = new Map(input.utterances.map((u) => [u.id, u.start_s]));
    const events: OrderEvent[] = [];
    for (const fid of timeline.fixture_ids) {
      const script = this.scripts.get(fid);
      for (const group of script?.events ?? []) {
        const mapped = group.map((e) => ({ ...e, source_utterance_ids: e.source_utterance_ids.map((u) => byTurn.get(`${fid}#${Number(u.slice(1)) - 1}`) ?? u) }));
        if (!mapped.some((e) => e.source_utterance_ids.some((u) => inSegment.has(u)))) continue;
        // Only what was said inside this conversation so far (a reopened order adds the rest later).
        for (const e of mapped.filter((x) => x.source_utterance_ids.every((u) => inSegment.has(u)))) {
          const t = e.source_utterance_ids.map((u) => start.get(u)).filter((x): x is number => x !== undefined);
          events.push(OrderEvent.parse({ ...e, t_s: t.length ? Math.max(...t) : null }));
        }
      }
    }
    return { ...empty, events };
  }
}
