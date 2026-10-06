import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../test-helpers";
import { groundTruthFor, matchSpans } from "./ground-truth";

const fixtures = path.join(repoRoot, "fixtures");

describe("ground truth (E6)", () => {
  it("a fixture's audio has a known answer from its timeline and script", () => {
    const t = groundTruthFor(fixtures, path.join(fixtures, "audio/04_correction.mono.clean.mp3"));
    expect(t?.expected.map((e) => [e.span, e.order.status, e.order.items.map((i) => i.catalog_id)])).toEqual([[0, "completed", ["spicy_chicken", "sprite"]]]);
  });

  it("a compilation knows every car in it", () => {
    expect(groundTruthFor(fixtures, path.join(fixtures, "audio/compilation_a.mono.moderate.mp3"))?.expected.length).toBeGreaterThan(1);
  });

  it("anything outside the fixtures folder (uploads, live sessions) has none", () => {
    expect(groundTruthFor(fixtures, "/tmp/upload.mp3")).toBeNull();
    expect(groundTruthFor(fixtures, "")).toBeNull();
    expect(groundTruthFor(fixtures, path.join(fixtures, "../package.json"))).toBeNull();
  });

  it("each expected span takes the unused segment it overlaps most", () => {
    const m = matchSpans(
      [
        { start_s: 0, end_s: 10 },
        { start_s: 12, end_s: 20 },
      ],
      [
        { segment_id: "a", start_s: 11, end_s: 19 },
        { segment_id: "b", start_s: 1, end_s: 9 },
      ],
    );
    expect(m.map((s) => s?.segment_id)).toEqual(["b", "a"]);
  });
});
