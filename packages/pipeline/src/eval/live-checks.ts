/**
 * Live-path checklist rows (29 to 41): small purpose-built replays through the
 * lane, each with its own pass condition. Free: script transcriber, and the
 * eval's extractor (the oracle for the ceiling run).
 */
import path from "node:path";
import type { Engine } from "../engine";
import { FileReplaySource } from "../input/file-replay";
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

const audio = (engine: Engine, id: string) => path.join(engine.cfg.paths.fixturesDir, "audio", `${id}.mono.clean.mp3`);

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

export async function runLiveChecks(engine: Engine): Promise<LiveCheck[]> {
  const checks = [oldRecording, twoLanes];
  const out: LiveCheck[] = [];
  for (const c of checks) {
    try {
      out.push(await c(engine));
    } catch (e) {
      out.push({ row: Number.NaN, pass: false, detail: `${c.name}: ${(e as Error).message}` });
    }
  }
  return out;
}
