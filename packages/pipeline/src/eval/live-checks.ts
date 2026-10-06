/**
 * Live-path checklist rows (29 to 41): small purpose-built replays through the
 * lane, each with its own pass condition. Free: script transcriber, and the
 * eval's extractor (the oracle for the ceiling run).
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import type { Engine } from "../engine";
import { issueTicket } from "../input/auth/tokens";
import { FileReplaySource } from "../input/file-replay";
import { replayOverWs } from "../input/ws-replay";
import { startService } from "../server/serve";
import { Scenario, type ScenarioInput } from "../input/scenario";
import { loadTimeline } from "../transcribe/script";
import { mergeSources } from "../input/merge";
import { LaneManager } from "../lane/manager";
import { replayFile } from "../lane/replay";
import { ScriptStreamingTranscriber } from "../lane/script-transcriber";
import { newId } from "../lib/ids";

export interface LiveCheck {
  row: number;
  pass: boolean;
  detail: string;
}

/** The mono rendering of a fixture, whatever its noise level. */
function audio(engine: Engine, id: string): string {
  const dir = path.join(engine.cfg.paths.fixturesDir, "audio");
  const hit = readdirSync(dir).find((f) => f.startsWith(`${id}.mono.`) && f.endsWith(".mp3"));
  return path.join(dir, hit ?? `${id}.mono.clean.mp3`);
}

/** Row 37: a recording replayed today carries the times it was spoken. */
async function oldRecording(engine: Engine): Promise<LiveCheck> {
  const r = await replayFile(engine, audio(engine, "01_simple"), { transcriber: new ScriptStreamingTranscriber(), deliver: false, anchorAt: "2025-01-15T09:30:00.000Z" });
  const t = r.orders[0]?.payload.times;
  const pass = t?.started_at === "2025-01-15T09:30:01.000Z" && t.time_basis === "recording_metadata" && Date.parse(t.finalized_at) > Date.parse("2026-01-01");
  return { row: 37, pass, detail: `started_at ${t?.started_at ?? "-"}, finalized_at ${t?.finalized_at.slice(0, 10) ?? "-"}` };
}

/** Row 40: two lanes streaming at once never mix ids, audio or orders. */
async function twoLanes(engine: Engine): Promise<LiveCheck> {
  const a = new FileReplaySource(audio(engine, "01_simple"), { storeId: "store_a", laneId: "lane_1" });
  const b = new FileReplaySource(audio(engine, "04_correction"), { storeId: "store_b", laneId: "lane_2" });
  const manager = new LaneManager({ engine, transcriber: new ScriptStreamingTranscriber(), runId: newId("run"), deliver: false });
  for await (const m of mergeSources([a, b])) await manager.handle(m);
  await manager.end();
  const lanes = [...manager.lanes.values()];
  const la = manager.lanes.get("store_a:lane_1");
  const lb = manager.lanes.get("store_b:lane_2");
  const items = (l: typeof la) => l?.orders.flatMap((o) => o.order.items.map((i) => i.catalog_id)).sort().join(",") ?? "";
  const ids = (l: typeof la) => l?.orders.every((o) => o.payload.store_id === l.storeId && o.payload.lane_id === l.laneId) ?? false;
  const textA = la?.transcript().utterances.map((u) => u.text).join(" ") ?? "";
  const pass =
    lanes.length === 2 &&
    ids(la) &&
    ids(lb) &&
    items(la) === "dbl_cheese,fries" &&
    items(lb) === "spicy_chicken,sprite" &&
    !/spicy/i.test(textA);
  return { row: 40, pass, detail: `store_a: ${items(la)}; store_b: ${items(lb)}` };
}

/** Replay one fixture with a scenario built from its own timeline. */
async function replay(engine: Engine, id: string, scenario: (t: { end: (uid: string) => number }) => Omit<ScenarioInput, "name">) {
  const file = audio(engine, id);
  const tl = loadTimeline(file);
  const end = (uid: string) => tl?.utterances.find((u) => u.id === uid)?.end_s ?? 0;
  return replayFile(engine, file, { transcriber: new ScriptStreamingTranscriber(), deliver: false, scenario: Scenario.parse({ ...scenario({ end }), name: "check" }) });
}

/** Row 29: the stream pauses right after the crew's closing cue: completed, the cue is the evidence. */
async function pauseAfterClose(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "01_simple", ({ end }) => ({ pauses: [{ at_s: end("u5") + 0.3, for_s: 20 }] }));
  const o = r.orders[0]?.order;
  const pass = r.orders.length === 1 && o?.status === "completed" && o.outcome_evidence[0]?.kind === "closing" && o.outcome_evidence.some((e) => e.event === "stream_paused" && e.context_only);
  return { row: 29, pass, detail: `${o?.status ?? "no order"}; evidence ${o?.outcome_evidence.map((e) => e.kind ?? e.event).join(", ") ?? "-"}` };
}

/** Row 30: the stream pauses mid-order with no cue: undetermined, never completed. */
async function pauseMidOrder(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "01_simple", ({ end }) => ({ pauses: [{ at_s: end("u2") + 0.5, for_s: 60 }] }));
  const o = r.orders[0]?.order;
  const pass = r.orders.length === 1 && o?.status === "undetermined" && (o.outcome_evidence.every((e) => e.context_only) ?? false) && o.review.reasons.includes("outcome_undetermined");
  return { row: 30, pass, detail: `${o?.status ?? "no order"}; review ${o?.review.reasons.join(", ") ?? "-"}` };
}

/** Row 31: a 10 s disconnect that comes back: one order, flagged stream_gap. */
async function disconnectReconnect(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "01_simple", ({ end }) => ({ disconnects: [{ at_s: end("u2") + 0.2, for_s: 10, reconnect: true }] }));
  const flags = r.orders.flatMap((o) => o.order.flags);
  const pass = r.orders.length === 1 && flags.includes("stream_gap") && !flags.includes("stream_interrupted");
  return { row: 31, pass, detail: `${r.orders.length} order(s); flags ${flags.join(", ") || "-"}` };
}

/** Row 32: a disconnect longer than the grace window: undetermined, stream_interrupted. */
async function disconnectLong(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "01_simple", ({ end }) => ({ disconnects: [{ at_s: end("u2") + 0.2, for_s: 600, reconnect: false }] }));
  const o = r.orders[0]?.order;
  const pass = r.orders.length === 1 && o?.status === "undetermined" && o.flags.includes("stream_interrupted");
  return { row: 32, pass, detail: `${o?.status ?? "no order"}; flags ${o?.flags.join(", ") ?? "-"}` };
}

/** Row 33: the car leaves before any close: abandoned, with the vehicle event as evidence. */
async function departsBeforeClose(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "07_abandoned", () => ({ vehicle_events: "on" }));
  const o = r.orders[0]?.order;
  const pass = o?.status === "abandoned" && o.outcome_evidence[0]?.event === "vehicle_departed";
  return { row: 33, pass, detail: `${o?.status ?? "no order"}; evidence ${o?.outcome_evidence.map((e) => e.kind ?? e.event).join(", ") ?? "-"}` };
}

/** Row 38: with vehicle events, every conversation opens on its car's arrival. */
async function boundariesFollowEvents(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "compilation_a", () => ({ vehicle_events: "on" }));
  const opens = r.decisions.filter((d) => d.to === "ACTIVE" && (d.from === "IDLE" || d.from === "FINALIZED"));
  const byArrival = opens.filter((d) => d.trigger === "vehicle_arrived").length;
  const tl = loadTimeline(audio(engine, "compilation_a"));
  const cars = new Set(tl?.orders.map((o) => `${o.start_s}`)).size;
  const pass = r.segmentation.segments.length === cars && byArrival === cars;
  return { row: 38, pass, detail: `${r.segmentation.segments.length} conversations, ${byArrival} opened by vehicle_arrived, ${cars} cars` };
}

/** Row 39: an unclear item in a finished order: completed, with review.required. */
async function unclearItem(engine: Engine): Promise<LiveCheck> {
  const r = await replay(engine, "14_garbled", () => ({}));
  const o = r.orders[0]?.order;
  const pass = o?.status === "completed" && o.review.required && o.review.reasons.includes("unclear_items");
  return { row: 39, pass, detail: `${o?.status ?? "no order"}; review ${o?.review.reasons.join(", ") ?? "-"}` };
}

/** Row 36: every wire codec over a real socket gives the same transcript as PCM. */
async function wireCodecs(engine: Engine): Promise<LiveCheck> {
  const service = await startService(engine, { host: "127.0.0.1", port: 0, devRoutes: true, record: false, skipClockCheck: true, deliver: false, log: () => {} });
  const url = `ws://127.0.0.1:${service.server.address.port}`;
  const file = audio(engine, "01_simple");
  const codecs = ["pcm_s16le", "mulaw", "alaw", "opus", "mp3", "aac", "wav", "ogg", "flac"] as const;
  try {
    for (const codec of codecs) {
      const laneId = `codec_${codec}`;
      await replayOverWs(file, {
        url,
        ticket: () => issueTicket(engine.db, { storeId: "store_codecs", laneId }).ticket,
        scenario: Scenario.parse({ name: `codec-${codec}`, codec, frame_ms: codec === "opus" ? 20 : 100 }),
        storeId: "store_codecs",
        laneId,
        fixtureId: "01_simple",
      });
    }
  } finally {
    await service.stop();
  }
  const lane = (codec: string) => service.manager.lane("store_codecs", `codec_${codec}`);
  const words = (codec: string) => lane(codec)?.transcript().utterances.map((u) => `${u.id}:${u.text}`).join("|") ?? "";
  const reference = words("pcm_s16le");
  const durations = codecs.map((c) => lane(c)?.transcript().audio.duration_s ?? 0);
  const ref = durations[0] ?? 0;
  const bad = codecs.filter((c, i) => words(c) !== reference || Math.abs((durations[i] ?? 0) - ref) > Math.max(0.5, ref * 0.03));
  const pass = reference.length > 0 && bad.length === 0;
  return { row: 36, pass, detail: pass ? `${codecs.length} codecs, same ${lane("pcm_s16le")?.transcript().utterances.length ?? 0} utterances, audio within 3%` : `differs: ${bad.join(", ")}` };
}

export async function runLiveChecks(engine: Engine): Promise<LiveCheck[]> {
  const checks = [wireCodecs, pauseAfterClose, pauseMidOrder, disconnectReconnect, disconnectLong, departsBeforeClose, oldRecording, boundariesFollowEvents, unclearItem, twoLanes];
  const out: LiveCheck[] = [];
  for (const c of checks) {
    try {
      out.push(await c(engine));
    } catch (e) {
      out.push({ row: Number.NaN, pass: false, detail: `${c.name}: ${(e as Error).message}` });
      engine.log(`live check ${c.name} failed: ${(e as Error).message}`);
    }
  }
  return out;
}
