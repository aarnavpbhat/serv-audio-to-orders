/** Lane path: replays through FileReplaySource -> lane -> script streaming transcriber -> orders. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../run";
import { Scenario } from "../input/scenario";
import { emptyUsage } from "../extract/types";
import { events, repoRoot, testEngine } from "../test-helpers";
import type { StreamingTranscriber } from "./types";
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
    const v2 = await replayFile(engine, file, { transcriber: new ScriptStreamingTranscriber(), deliver: false, mode: "batch" });
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

describe("lane ids", () => {
  it("refuses a session whose store, lane or session id could escape a file path", async () => {
    const manager = new LaneManager({ engine: testEngine(), transcriber: new ScriptStreamingTranscriber(), runId: "run_t", deliver: false });
    await manager.handle({
      kind: "session_open",
      session: { sessionId: "ses_1", storeId: "../../etc", laneId: "lane_1", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: new Date().toISOString(), codecIn: "pcm_s16le" },
    });
    expect(manager.lanes.size).toBe(0);
    expect(manager.rejected.has("ses_1")).toBe(true);
  });
});

describe("guessed roles", () => {
  it("a conversation whose lines were all guessed as crew still makes an order after the LLM role pass", async () => {
    const lines = [
      { text: "Welcome, what can I get for you today?", role: "crew" as const },
      { text: "Can I get a cheeseburger and a medium fries?", role: "customer" as const },
      { text: "Your total is $5.78, please pull forward.", role: "crew" as const },
    ];
    // A transcriber that hears one voice and guesses every line wrong (all crew).
    const transcriber: StreamingTranscriber = {
      name: "stub/guessed",
      open: (session, h) => {
        let sent = false;
        return {
          push: () => {
            if (sent) return;
            sent = true;
            lines.forEach((l, i) => h.utterance({ sessionId: session.sessionId, speaker: "crew", speakerGuessed: true, start_s: i * 4, end_s: i * 4 + 3, text: l.text, confidence: 0.9, words: [] }));
          },
          pause: () => {},
          resume: () => {},
          end: async () => {},
          close: () => {},
          audioMinutes: () => 0,
          watermarkS: () => Number.POSITIVE_INFINITY,
        };
      },
    };
    const engine = testEngine();
    const labels: string[][] = [];
    engine.judge = {
      isNewCustomer: async () => false,
      labelLines: async (texts) => {
        labels.push(texts);
        return lines.map((l) => l.role);
      },
    };
    engine.extractor = { name: "stub", extract: async () => ({ events: events([{ event_id: "e1", type: "ADD", catalog_id: "cheeseburger", source_utterance_ids: ["u2"] }]), usage: emptyUsage("none"), warnings: [], raw: null, repaired: false, fallback: false }) };
    const manager = new LaneManager({ engine, transcriber, runId: "run_roles", deliver: false });
    const at = (s: number) => new Date(Date.parse("2026-10-03T18:40:00Z") + s * 1000).toISOString();
    await manager.handle({ kind: "session_open", session: { sessionId: "ses_r", storeId: "s", laneId: "l", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: at(0), codecIn: "pcm_s16le" } });
    await manager.handle({ kind: "audio", frame: { sessionId: "ses_r", seq: 0, sampleOffset: 0, receivedAt: at(0), pcm: [new Int16Array(16000)] } });
    await manager.handle({ kind: "tick", at: at(20) });
    await manager.end();
    const lane = [...manager.lanes.values()][0]!;
    expect(labels).toHaveLength(1);
    expect(lane.orders.map((o) => o.order.items.map((i) => i.catalog_id))).toEqual([["cheeseburger"]]);
  });
});
