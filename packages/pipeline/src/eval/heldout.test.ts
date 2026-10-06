/** Held-out set (D8): import a recording, write its expected order by hand, score it apart from the main eval. */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptStreamingTranscriber } from "../lane/script-transcriber";
import { repoRoot, testEngine } from "../test-helpers";
import { importRecording, listFolderFixtures, runFolderEval } from "./heldout";

describe("held-out set", () => {
  it("imports a recording, refuses a duplicate name, and scores it into its own report", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "serv-heldout-"));
    const engine = testEngine();
    engine.cfg = { ...engine.cfg, paths: { ...engine.cfg.paths, fixturesDir: path.join(tmp, "fixtures"), evalDir: path.join(tmp, "eval") } };
    const src = path.join(repoRoot, "fixtures/audio/01_simple.mono.clean.mp3");

    const r = await importRecording(engine.cfg.paths.fixturesDir, src, "phone_01");
    expect(r.seconds).toBeGreaterThan(5);
    await expect(importRecording(engine.cfg.paths.fixturesDir, src, "phone_01")).rejects.toThrow(/already exists/);
    await expect(importRecording(engine.cfg.paths.fixturesDir, src, "../escape")).rejects.toThrow();

    // Not scored until someone writes the expected orders.
    let report = await runFolderEval(engine, { set: "heldout", transcriber: new ScriptStreamingTranscriber() });
    expect(report.fixtures[0]?.error).toMatch(/fill it in by hand/);

    // Hand-written expected order; the free transcriber needs the fixture's script next to the audio.
    writeFileSync(path.join(r.dir, "expected.json"), JSON.stringify({ orders: [{ status: "completed", items: [{ catalog_id: "dbl_cheese", quantity: 1 }, { catalog_id: "fries", quantity: 1, size: "medium" }] }] }));
    copyFileSync(path.join(repoRoot, "fixtures/audio/01_simple.timeline.json"), path.join(r.dir, "audio.timeline.json"));
    expect(listFolderFixtures(engine.cfg.paths.fixturesDir, "heldout").map((f) => f.name)).toEqual(["phone_01"]);
    report = await runFolderEval(engine, { set: "heldout", transcriber: new ScriptStreamingTranscriber() });
    expect(report.summary).toMatchObject({ fixtures: 1, passed: 1, item_precision: 1, item_recall: 1, status_accuracy: 1 });
    expect(report.note).toMatch(/never used to tune/);
    expect(existsSync(path.join(engine.cfg.paths.evalDir, "heldout-report.json"))).toBe(true);
    expect(existsSync(path.join(engine.cfg.paths.evalDir, "report.json"))).toBe(false);
  }, 60_000);

  it("the main eval never reads fixtures/heldout", () => {
    const src = readFileSync(path.join(import.meta.dirname, "run-eval.ts"), "utf8");
    expect(src).not.toMatch(/heldout/);
  });
});
