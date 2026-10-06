/** Step 5 gate: rule segmentation on ground-truth transcripts of every fixture file. */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "@serv/config";
import { ingest } from "../ingest/ingest";
import { segmentTranscript, type SegmentConfig } from "../segment/segment";
import { ScriptTranscriber, loadTimeline } from "../transcribe/script";
import type { TranscribeOptions } from "../transcribe/types";
import { loadFixtureScripts } from "../fixtures/load";
import { repoRoot } from "../test-helpers";

const cfg = getConfig();
const segCfg: SegmentConfig = { ...cfg.segment, lowAudioQualityMeanConf: cfg.lowAudioQualityMeanConf };
const audioDir = path.join(repoRoot, "fixtures/audio");
// A late addition after the close is one car to the live tracker (it reopens the order), but
// v1's whole-file rules see two conversations; recordings with a live-only fixture are covered
// by the tracker tests instead.
const liveOnly = new Set(loadFixtureScripts(path.join(repoRoot, "fixtures/scripts")).filter((s) => s.live_only).map((s) => s.id));
const files = readdirSync(audioDir).filter(
  (f) => /\.mono\.(clean|moderate|heavy)\.mp3$/.test(f) && !(loadTimeline(path.join(audioDir, f))?.fixture_ids ?? []).some((id) => liveOnly.has(id)),
);
const opts: TranscribeOptions = { channelMap: null, keyterms: [], language: "en", cacheDir: "", lowConfWord: 0.6 };

async function segmentsFor(file: string) {
  const full = path.join(audioDir, file);
  const input = await ingest(full, { audioStartUtc: "2026-10-03T18:40:00Z" });
  const { transcript } = await new ScriptTranscriber().transcribe(input, opts);
  return { seg: await segmentTranscript(transcript, segCfg, null), timeline: loadTimeline(full)! };
}

describe("segmentation on fixture timelines", () => {
  for (const file of files) {
    it(file, async () => {
      const { seg, timeline } = await segmentsFor(file);
      // Split payments share one conversation span, so count distinct spans.
      const spans = [...new Map(timeline.orders.map((o) => [`${o.start_s}-${o.end_s}`, o])).values()];
      expect(seg.segments.map((s) => s.segment_id)).toHaveLength(spans.length);
      spans.forEach((span, i) => {
        const s = seg.segments[i]!;
        expect(Math.abs(s.start_s - span.start_s)).toBeLessThan(1.5);
        expect(Math.abs(s.end_s - span.end_s)).toBeLessThan(1.5);
      });
      expect(seg.llm_calls).toBe(0);
    });
  }

  it("flags truncation, non-English and crew chatter", async () => {
    const start = (await segmentsFor("19_truncated_start.mono.clean.mp3")).seg.segments[0]!;
    expect([start.truncated_start, start.truncated_end, start.has_closing]).toEqual([true, false, true]);
    const end = (await segmentsFor("20_truncated_end.mono.clean.mp3")).seg.segments[0]!;
    expect([end.truncated_start, end.truncated_end, end.has_closing]).toEqual([false, true, false]);
    const abandoned = (await segmentsFor("07_abandoned.mono.clean.mp3")).seg.segments[0]!;
    expect([abandoned.truncated_end, abandoned.has_closing]).toEqual([false, false]);
    expect((await segmentsFor("21_spanish.mono.clean.mp3")).seg.segments[0]!.non_english).toBe(true);
    const chatter = (await segmentsFor("16_crew_crosstalk.mono.clean.mp3")).seg.segments[0]!;
    expect(chatter.non_customer_ids).toEqual(["u3"]);
  });
});
