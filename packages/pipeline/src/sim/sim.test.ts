/** Simulator back end: the five acted scenarios over the real endpoint (text mode), and Save as fixture. */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { issueTicket } from "../input/auth/tokens";
import { int16ToS16le } from "../input/pcm";
import { FuzzyExtractor } from "../extract/fuzzy-extractor";
import { startService } from "../server/serve";
import { testEngine } from "../test-helpers";
import { runActedScenarios } from "./acted-scenarios";
import { saveLiveFixture } from "./save-fixture";

describe("simulator", () => {
  it("the acted scenarios end as expected over the real endpoint (statuses, versions, flags)", async () => {
    const engine = testEngine();
    engine.extractor = new FuzzyExtractor();
    const results = await runActedScenarios(engine);
    expect(results.filter((r) => r.id !== "correction").map((r) => [r.id, r.pass, r.problems])).toEqual([
      ["simple", true, []],
      ["late_addition", true, []],
      ["car_left", true, []],
      ["dropped", true, []],
    ]);
    // The keyword extractor cannot read a correction (everything lands in review, so the
    // close has no confirmed item). Here it only has to make one order; `pnpm feed sim-check`
    // runs all five with Gemini.
    expect(results.find((r) => r.id === "correction")?.orders.map((o) => o.version)).toEqual([1]);
  }, 90_000);

  it("Save as fixture writes audio, raw capture, timeline and the expected order; never overwrites", async () => {
    const engine = testEngine();
    const tmp = mkdtempSync(path.join(os.tmpdir(), "serv-sim-"));
    engine.cfg = { ...engine.cfg, paths: { ...engine.cfg.paths, fixturesDir: path.join(tmp, "fixtures") } };
    const service = await startService(engine, { host: "127.0.0.1", port: 0, devRoutes: true, skipClockCheck: true, deliver: false, liveFeed: false, stagingRoot: path.join(tmp, "staging"), log: () => {} });
    const since = Date.now();
    const t = issueTicket(engine.db, { storeId: "store_sim", laneId: "lane_9" });
    const ws = new WebSocket(`ws://127.0.0.1:${service.server.address.port}/hme/v1/stream?lane=lane_9&codec=pcm_s16le&rate=16000&channels=1&ticket=${t.ticket}`);
    await new Promise((r) => ws.once("open", r));
    for (let i = 0; i < 25; i++) ws.send(int16ToS16le(new Int16Array(320).fill(i * 100)));
    ws.send(JSON.stringify({ type: "vehicle_arrived" }));
    ws.send(JSON.stringify({ type: "utterance", speaker: "customer", text: "A cheeseburger please" }));
    await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => {
      ws.once("close", r);
      ws.close(1000);
    });
    await service.stop();

    const input = { name: "sim_test_1", storeId: "store_sim", laneId: "lane_9", since, until: Date.now(), expected: [{ status: "completed" as const, items: [{ catalog_id: "cheeseburger", quantity: 1 }] }], speakerLabels: [{ start_ms: since, end_ms: since + 500, speaker: "crew" as const }] };
    const saved = await saveLiveFixture(engine, input);
    expect(saved.dir).toBe(path.join(engine.cfg.paths.fixturesDir, "live", "sim_test_1"));
    expect(saved.audioSeconds).toBeCloseTo(0.5, 1);
    const timeline = JSON.parse(readFileSync(path.join(saved.dir, "timeline.json"), "utf8")) as { vehicle_events: { type: string }[]; text_lines: { text: string }[]; speaker_labels: unknown[] };
    expect(timeline.vehicle_events.map((e) => e.type)).toEqual(["vehicle_arrived"]);
    expect(timeline.text_lines.map((l) => l.text)).toEqual(["A cheeseburger please"]);
    expect(timeline.speaker_labels).toHaveLength(1);
    expect(existsSync(path.join(saved.dir, "audio.flac"))).toBe(true);
    expect(existsSync(path.join(saved.dir, "raw", saved.sessions[0] ?? "", "session.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(saved.dir, "expected.json"), "utf8"))).toMatchObject({ held_out: false, orders: [{ status: "completed" }] });

    await expect(saveLiveFixture(engine, input)).rejects.toThrow(/already exists/);
    await expect(saveLiveFixture(engine, { ...input, name: "../escape" })).rejects.toThrow();
    const held = await saveLiveFixture(engine, { ...input, name: "sim_test_2", heldOut: true });
    expect(held.dir).toBe(path.join(engine.cfg.paths.fixturesDir, "heldout", "sim_test_2"));
  }, 30_000);
});
