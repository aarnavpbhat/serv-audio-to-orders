/** Test Lab: scenarios, the perfect-words replay, attribution and the metrics. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FuzzyExtractor } from "../extract/fuzzy-extractor";
import type { TruthRow } from "../eval/ground-truth";
import type { OrderPayload } from "../schemas";
import { repoRoot, testEngine } from "../test-helpers";
import { actionsAt, loadScenarios } from "./scenario";
import { attribute, perfectRun, roleAccuracy, wordErrorRate } from "./score";

const engine = testEngine();
engine.extractor = new FuzzyExtractor();
const scenarios = loadScenarios(path.join(repoRoot, "testlab/scenarios"), engine.catalog);
const byId = (id: string) => scenarios.find((s) => s.id === id) ?? (() => { throw new Error(id); })();

describe("Test Lab scenarios", () => {
  it("ten scenarios, numbered 1 to 10, every expected item on the menu", () => {
    expect(scenarios.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("actions happen at the start, after a line, or at the end", () => {
    const blip = byId("connection_blip");
    expect(actionsAt(blip, "start").map((a) => a.do)).toEqual(["car_arrived"]);
    expect(actionsAt(blip, 3).map((a) => [a.do, a.seconds])).toEqual([["drop", 8]]);
    expect(actionsAt(blip, "end").map((a) => a.do)).toEqual(["car_left"]);
  });
});

describe("perfect-words replay (free extractor)", () => {
  it("a late add-on reopens the order as version 2", async () => {
    const orders = await perfectRun(engine, byId("late_add_on"));
    expect(orders.map((o) => o.payload.order_version)).toEqual([2]);
  });

  it("two cars make two orders; a lost connection ends undetermined after the grace period", async () => {
    expect(await perfectRun(engine, byId("two_cars"))).toHaveLength(2);
    const lost = await perfectRun(engine, byId("connection_lost"));
    expect(lost.map((o) => [o.payload.status, o.payload.flags.includes("stream_interrupted")])).toEqual([["undetermined", true]]);
  });
});

const row = (diffs: string[], actual: Partial<OrderPayload> | null = { items: [], needs_review: [], not_ordered: [] }): TruthRow =>
  ({ span: null, segmentId: null, expected: null, actual, comparison: { diffs, pass: diffs.length === 0 } }) as unknown as TruthRow;

describe("attribution", () => {
  it("only the live run has it: heard wrong; both have it: understood wrong", () => {
    const live = [row(["missing item coke|x1|large||", "status: expected completed, got undetermined"])];
    const perfect = [row(["status: expected completed, got undetermined"])];
    expect(attribute(live, perfect, 1).map((a) => a.where)).toEqual(["heard wrong", "understood wrong"]);
  });

  it("the live run lost an item the perfect run noticed (as unclear): heard wrong", () => {
    const noticed = { items: [], needs_review: [{ catalog_id: "coke", candidates: [] }], not_ordered: [] } as unknown as OrderPayload;
    const live = [row(["missing item coke|x1|large||"])];
    const perfect = [row(["missing item coke|x1|large||"], noticed)];
    expect(attribute(live, perfect, 1)[0]?.where).toBe("heard wrong");
  });

  it("a missing, extra or unreopened order is timing", () => {
    expect(attribute([row(["order missing"], null)], [row([])], 1)[0]?.where).toBe("timing");
    expect(attribute([row(["order_version: expected 2, got 1"])], [row([])], 1)[0]?.where).toBe("timing");
  });
});

describe("metrics", () => {
  it("word error rate counts substitutions, insertions and deletions over the script's words", () => {
    expect(wordErrorRate("Can I get a large Coke?", "can i get a large coke")).toBe(0);
    expect(wordErrorRate("Can I get a large Coke?", "can I get a large cook")).toBeCloseTo(1 / 6, 3);
    expect(wordErrorRate("a b c d", "a c d e")).toBe(0.5);
    expect(wordErrorRate("", "x")).toBeNull();
  });

  it("role accuracy is the share of heard lines matched to a script line with the right speaker", () => {
    const script = [
      { role: "crew" as const, text: "Welcome, what can I get for you?" },
      { role: "customer" as const, text: "A cheeseburger please." },
    ];
    expect(roleAccuracy(script, [{ speaker: "crew", text: "Welcome, what can I get for you?" }, { speaker: "crew", text: "A cheeseburger please" }])).toBe(0.5);
    expect(roleAccuracy(script, [{ speaker: "crew", text: "something else entirely" }])).toBeNull();
  });
});
