/** Lane path: replays through FileReplaySource -> lane -> script streaming transcriber -> orders. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../run";
import { Scenario } from "../input/scenario";
import { repoRoot, testEngine } from "../test-helpers";
import { LaneManager } from "./manager";
import { replayFile } from "./replay";
import { ScriptStreamingTranscriber } from "./script-transcriber";

const audio = (id: string) => path.join(repoRoot, `fixtures/audio/${id}.mono.clean.mp3`);
const shape = (orders: { order: { status: string; items: { catalog_id: string; quantity: number }[]; review: unknown; flags: string[] } }[]) =>
  orders.map((o) => ({ status: o.order.status, review: o.order.review, flags: o.order.flags, items: o.order.items.map((i) => `${i.quantity}x${i.catalog_id}`) }));

describe("replay through the lane", () => {
  it("matches the v1 file path on the same fixture (plan D1 parity)", async () => {
    const engine = testEngine();
    const file = audio("18_back_to_back");
    const v1 = await runPipeline(engine, file, { channelMap: null, audioStartUtc: "2026-10-03T18:40:00Z", deliver: false });
    const v2 = await replayFile(engine, file, { transcriber: new ScriptStreamingTranscriber(), deliver: false });
    expect(shape(v2.orders)).toEqual(shape(v1.orders));
    expect(v2.segmentation.segments.map((s) => [s.start_s, s.end_s])).toEqual(v1.segmentation.segments.map((s) => [s.start_s, s.end_s]));
  });

  it("stamps recording time and the replay's store and lane on every order", async () => {
    const r = await replayFile(testEngine(), audio("01_simple"), { transcriber: new ScriptStreamingTranscriber(), deliver: false, storeId: "store_x", laneId: "lane_9" });
    const p = r.orders[0]?.payload;
    expect(p).toMatchObject({ store_id: "store_x", lane_id: "lane_9", source: { type: "file_replay" }, times: { time_basis: "recording_metadata", started_at: "2026-10-03T18:40:01.000Z" } });
    expect(p?.audio_ref.sample_start).toBe(16000);
  });

  it("audio that never arrived is never transcribed", async () => {
    const scenario = Scenario.parse({ name: "t", pauses: [{ at_s: 5, for_s: 6 }] });
    const r = await replayFile(testEngine(), audio("01_simple"), { transcriber: new ScriptStreamingTranscriber(), deliver: false, scenario });
    const heard = r.transcript.utterances.map((u) => u.id);
    expect(heard).not.toContain("u2"); // the customer's order was spoken during the pause
    expect(heard).toContain("u1");
  });

  it("a reconnect continues the same lane; utterances keep recording time", async () => {
    const scenario = Scenario.parse({ name: "t", disconnects: [{ at_s: 12, for_s: 1 }] });
    const engine = testEngine();
    const manager = new LaneManager({ engine, transcriber: new ScriptStreamingTranscriber(), runId: "run_t", deliver: false });
    const { FileReplaySource } = await import("../input/file-replay");
    for await (const m of new FileReplaySource(audio("01_simple"), { scenario }).messages()) await manager.handle(m);
    await manager.end();
    expect(manager.lanes.size).toBe(1);
    const lane = [...manager.lanes.values()][0]!;
    const late = lane.transcript().utterances.at(-1);
    // Heard on the second session, still placed on the original recording axis.
    expect(late?.start_s).toBeGreaterThan(14);
    expect(lane.orders[0]?.order.flags).toContain("stream_gap");
  });
});
