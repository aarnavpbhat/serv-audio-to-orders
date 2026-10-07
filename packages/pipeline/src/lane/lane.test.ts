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
import { FuzzyExtractor } from "../extract/fuzzy-extractor";
import { ScriptStreamingTranscriber } from "./script-transcriber";

const audio = (id: string) => path.join(repoRoot, `fixtures/audio/${id}.mono.clean.mp3`);
const shape = (orders: { order: { status: string; items: { catalog_id: string; quantity: number }[]; review: unknown; flags: string[] } }[]) =>
  orders.map((o) => ({ status: o.order.status, review: o.order.review, flags: o.order.flags, items: o.order.items.map((i) => `${i.quantity}x${i.catalog_id}`) }));

describe("replay through the lane", () => {
  it("pnpm pipeline run is a replay through the lane (plan D1): same orders, conversations and run record", async () => {
    const engine = testEngine();
    const file = audio("18_back_to_back");
    const run = await runPipeline(engine, file, { channelMap: null, deliver: false });
    const lane = await replayFile(engine, file, { transcriber: new ScriptStreamingTranscriber(), deliver: false });
    expect(shape(run.orders)).toEqual(shape(lane.orders));
    expect(run.orders).toHaveLength(2);
    expect(run.segmentation.segments.map((s) => [s.start_s, s.end_s])).toEqual(lane.segmentation.segments.map((s) => [s.start_s, s.end_s]));
    expect(run.orders.every((o) => o.payload.source.type === "file_replay")).toBe(true);
  });

  it("an empty or corrupt file fails before anything is sent", async () => {
    const engine = testEngine();
    await expect(runPipeline(engine, path.join(repoRoot, "menu/menu.json"), { deliver: false })).rejects.toThrow(/audio/i);
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

  it("a car diarized entirely as crew (not guessed) is checked too; with no LLM the wording decides", async () => {
    const texts = ["Hi. Welcome to Sandbox Burger. Go ahead whenever you're ready.", "Can I get a cheeseburger please?", "Your total is $2.99. See you at the window."];
    // Diarization put the customer's voice under the crew's label; nothing is marked guessed.
    const transcriber: StreamingTranscriber = {
      name: "stub/diarized",
      open: (session, h) => {
        let sent = false;
        return {
          push: () => {
            if (sent) return;
            sent = true;
            texts.forEach((text, i) => h.utterance({ sessionId: session.sessionId, speaker: "crew", start_s: i * 4, end_s: i * 4 + 3, text, confidence: 0.9, words: [] }));
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
    engine.extractor = { name: "stub", extract: async () => ({ events: events([{ event_id: "e1", type: "ADD", catalog_id: "cheeseburger", source_utterance_ids: ["u2"] }]), usage: emptyUsage("none"), warnings: [], raw: null, repaired: false, fallback: false }) };
    const manager = new LaneManager({ engine, transcriber, runId: "run_diar", deliver: false });
    const at = (s: number) => new Date(Date.parse("2026-10-03T18:40:00Z") + s * 1000).toISOString();
    await manager.handle({ kind: "session_open", session: { sessionId: "ses_d", storeId: "s", laneId: "l", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: at(0), codecIn: "pcm_s16le" } });
    await manager.handle({ kind: "audio", frame: { sessionId: "ses_d", seq: 0, sampleOffset: 0, receivedAt: at(0), pcm: [new Int16Array(16000)] } });
    await manager.handle({ kind: "tick", at: at(20) });
    await manager.end();
    const lane = [...manager.lanes.values()][0];
    expect(lane?.orders.map((o) => o.order.items.map((i) => i.catalog_id))).toEqual([["cheeseburger"]]);
    const roles = lane?.transcript().utterances.map((u) => [u.speaker, u.speaker_guessed ?? false]);
    expect(roles).toEqual([
      ["crew", false],
      ["customer", true],
      ["crew", false],
    ]);
  });

  describe("a car with no speech (E1, E2, E9)", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-03T18:40:00Z") + s * 1000).toISOString();
    async function drive(controls: [number, "vehicle_arrived" | "vehicle_departed" | "stream_paused"][], then?: (m: LaneManager) => Promise<unknown>) {
      const engine = testEngine();
      let extractions = 0;
      engine.extractor = { name: "stub", extract: async () => (extractions++, { events: [], usage: emptyUsage("none"), warnings: [], raw: null, repaired: false, fallback: false }) };
      const manager = new LaneManager({ engine, transcriber: new ScriptStreamingTranscriber(), runId: "run_quiet", deliver: false });
      await manager.handle({ kind: "session_open", session: { sessionId: "ses_q", storeId: "s", laneId: "l", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: at(0), codecIn: "pcm_s16le" } });
      for (const [t, type] of controls) await manager.handle({ kind: "control", event: { sessionId: "ses_q", at: at(t), type } });
      await then?.(manager);
      await manager.handle({ kind: "tick", at: at(60) });
      await manager.end();
      return { orders: [...manager.lanes.values()][0]?.orders ?? [], extractions };
    }

    it("arrives and leaves: one abandoned order, no items, no_speech, no review, no model call", async () => {
      const { orders, extractions } = await drive([
        [2, "vehicle_arrived"],
        [9, "vehicle_departed"],
      ]);
      expect(shape(orders)).toEqual([{ status: "abandoned", review: { required: false, reasons: [] }, flags: ["no_speech"], items: [] }]);
      expect(orders[0]?.payload.outcome_evidence.map((e) => e.type === "vehicle_event" && e.event)).toContain("vehicle_departed");
      expect(extractions).toBe(0);
    });

    it("arrives, then the stream pauses: nothing is sent", async () => {
      const { orders, extractions } = await drive([
        [2, "vehicle_arrived"],
        [5, "stream_paused"],
      ]);
      expect(orders).toEqual([]);
      expect(extractions).toBe(0);
    });

    it("arrives, then End session: nothing is sent", async () => {
      const { orders, extractions } = await drive([[2, "vehicle_arrived"]], (m) => m.stop("ses_q", "end", at(6)));
      expect(orders).toEqual([]);
      expect(extractions).toBe(0);
    });

    it("arrives, then the connection drops for good: nothing is sent", async () => {
      const { orders } = await drive([[2, "vehicle_arrived"]], async (m) => {
        await m.handle({ kind: "session_close", sessionId: "ses_q", at: at(6), reason: "error" });
        await m.handle({ kind: "tick", at: at(600) });
      });
      expect(orders).toEqual([]);
    });

    it("no vehicle event and no speech: nothing opens, nothing is sent", async () => {
      expect((await drive([[5, "stream_paused"]])).orders).toEqual([]);
    });
  });

  describe("operator stop (E3)", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-03T18:40:00Z") + s * 1000).toISOString();
    async function lane() {
      const engine = testEngine();
      engine.extractor = new FuzzyExtractor();
      const manager = new LaneManager({ engine, transcriber: new ScriptStreamingTranscriber(), runId: "run_stop", deliver: false });
      const open = (id: string, t: number) =>
        manager.handle({ kind: "session_open", session: { sessionId: id, storeId: "s", laneId: "l", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: at(t), codecIn: "pcm_s16le" } });
      const say = (id: string, t: number, speaker: "crew" | "customer", text: string) => manager.handle({ kind: "script_line", line: { sessionId: id, speaker, text, at: at(t) } });
      await open("ses_1", 0);
      await say("ses_1", 2, "crew", "Welcome, what can I get for you today?");
      await say("ses_1", 5, "customer", "Can I get a cheeseburger?");
      const orders = () => [...manager.lanes.values()][0]?.orders ?? [];
      // The free keyword extractor files short lines under needs_review: count every line heard.
      const heard = () => orders().map((o) => [...o.order.items, ...o.order.needs_review].map((i) => i.catalog_id));
      return { manager, open, say, orders, heard };
    }

    it("End mid-conversation sends the order now, flagged ended_by_operator; a second stop does nothing", async () => {
      const { manager, orders, heard } = await lane();
      expect(await manager.stop("ses_1", "end", at(7))).toBe(true);
      expect(orders().map((o) => o.order.flags.includes("ended_by_operator"))).toEqual([true]);
      expect(heard()).toEqual([["cheeseburger"]]);
      expect(await manager.stop("ses_1", "end", at(8))).toBe(true);
      await manager.handle({ kind: "session_close", sessionId: "ses_1", at: at(8), reason: "remote_close" });
      await manager.handle({ kind: "tick", at: at(400) });
      expect(orders()).toHaveLength(1);
    });

    it("Discard drops the open conversation: no order, ever", async () => {
      const { manager, orders } = await lane();
      expect(await manager.stop("ses_1", "discard", at(7))).toBe(true);
      await manager.handle({ kind: "session_close", sessionId: "ses_1", at: at(7), reason: "remote_close" });
      await manager.handle({ kind: "tick", at: at(400) });
      await manager.end();
      expect(orders()).toEqual([]);
    });

    it("works during reconnect backoff, and the lane takes a new connection right after", async () => {
      const { manager, open, say, orders, heard } = await lane();
      await manager.handle({ kind: "session_close", sessionId: "ses_1", at: at(6), reason: "remote_close" });
      expect(manager.sessions().map((s) => [s.sessionId, s.open])).toEqual([["ses_1", false]]);
      expect(await manager.stop("ses_1", "end", at(8))).toBe(true);
      expect(orders()).toHaveLength(1);
      expect(manager.sessions()).toEqual([]);
      await open("ses_2", 20);
      await say("ses_2", 22, "crew", "Welcome, what can I get for you today?");
      await say("ses_2", 25, "customer", "A medium fries please.");
      expect(await manager.stop("ses_2", "end", at(27))).toBe(true);
      expect(heard()).toEqual([["cheeseburger"], ["fries"]]);
      expect(await manager.stop("ses_unknown", "end", at(30))).toBe(false);
    });
  });

  it("typed lines (no fixture) still let the tracker's timers run: a close settles on the clock", async () => {
    const engine = testEngine();
    engine.extractor = new FuzzyExtractor();
    const manager = new LaneManager({ engine, transcriber: new ScriptStreamingTranscriber(), runId: "run_typed", deliver: false });
    const at = (s: number) => new Date(Date.parse("2026-10-03T18:40:00Z") + s * 1000).toISOString();
    await manager.handle({ kind: "session_open", session: { sessionId: "ses_t", storeId: "s", laneId: "l", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: at(0), codecIn: "pcm_s16le" } });
    await manager.handle({ kind: "script_line", line: { sessionId: "ses_t", speaker: "crew", text: "Welcome, what can I get for you today?", at: at(2) } });
    await manager.handle({ kind: "script_line", line: { sessionId: "ses_t", speaker: "customer", text: "Can I get a cheeseburger?", at: at(5) } });
    await manager.handle({ kind: "script_line", line: { sessionId: "ses_t", speaker: "crew", text: "Please pull forward to the window.", at: at(8) } });
    // Wall-clock ticks only (the feed service's 250 ms ticker), no audio.
    await manager.handle({ kind: "tick", at: at(12) });
    const lane = [...manager.lanes.values()][0];
    expect(lane?.decisions.map((d) => d.trigger)).toContain("settled");
    expect(lane?.orders).toHaveLength(1);
  });
});
