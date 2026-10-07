/**
 * The simulator's five acted scenarios (plan step 10, "done when"), scripted in
 * text mode and sent over the real endpoint exactly as the simulator page
 * sends them: a dev ticket, typed lines and event messages on /hme/v1/stream.
 * People acting them into the mic is the same check with Deepgram in front.
 *
 * Timers are shortened for the run (settle 0.6 s, reopen 8 s, grace 2 s) so
 * the five take seconds; the rules are the same.
 */
import WebSocket from "ws";
import type { Engine } from "../engine";
import { issueTicket } from "../input/auth/tokens";
import type { LaneUpdate } from "../lane/lane";
import { newId } from "../lib/ids";
import { sleep } from "../lib/retry";
import type { Flag, OrderPayload } from "../schemas";
import { startService } from "../server/serve";

type Step = { say: "crew" | "customer"; text: string } | { event: "vehicle_arrived" | "vehicle_departed" } | { wait: number } | { drop: true };

export interface ActedScenario {
  id: string;
  title: string;
  steps: Step[];
  expect: {
    status: OrderPayload["status"];
    version: number;
    flags?: Flag[];
    /** Catalog ids that must be in the items, and ones that must not (checked when the extractor reads corrections). */
    items?: string[];
    notItems?: string[];
  };
}

const crew = (text: string): Step => ({ say: "crew", text });
const customer = (text: string): Step => ({ say: "customer", text });

export const SHORT_TIMERS = { closeSettleS: 0.6, idleTimeoutS: 6, reconnectGraceS: 2, reopenWindowS: 8, maxConversationS: 120 };

export const ACTED_SCENARIOS: ActedScenario[] = [
  {
    id: "simple",
    title: "A simple order",
    steps: [crew("Welcome in, what can I get started for you?"), customer("Can I get a cheeseburger and a small fries?"), crew("Sure. Your total is $5.28, please pull forward."), { wait: 2500 }],
    expect: { status: "completed", version: 1, items: ["cheeseburger", "fries"] },
  },
  {
    id: "correction",
    title: "A correction (Coke to Sprite)",
    steps: [
      crew("Hi, what can I get you today?"),
      customer("A hamburger and a medium Coke please."),
      customer("Actually, make that a Sprite instead of the Coke."),
      crew("Okay, a hamburger and a medium Sprite. That'll be $4.48 at the window."),
      { wait: 2500 },
    ],
    expect: { status: "completed", version: 1, items: ["hamburger", "sprite"], notItems: ["coke"] },
  },
  {
    id: "late_addition",
    title: "A late \"add a water\" (reopen, order.updated v2)",
    steps: [
      crew("Welcome, go ahead when you're ready."),
      customer("Could I get a cheeseburger?"),
      crew("One cheeseburger, $2.99. Please pull forward."),
      { wait: 1200 },
      customer("Oh wait, can I also add a water?"),
      crew("Sure, I added a cup of water. Same total, pull forward."),
      { wait: 9500 },
    ],
    expect: { status: "completed", version: 2, items: ["cheeseburger", "water"] },
  },
  {
    id: "car_left",
    title: "Car left mid-order (abandoned)",
    steps: [{ event: "vehicle_arrived" }, crew("Hi there, what can I get you?"), customer("Um, let me get a cheeseburger and"), { wait: 400 }, { event: "vehicle_departed" }, { wait: 2500 }],
    expect: { status: "abandoned", version: 1 },
  },
  {
    id: "dropped",
    title: "Connection dropped mid-order, no reconnect (undetermined)",
    steps: [crew("Welcome, what can I get for you?"), customer("I'd like a chicken sandwich and"), { wait: 300 }, { drop: true }, { wait: 4500 }],
    expect: { status: "undetermined", version: 1, flags: ["stream_interrupted"] },
  },
];

export interface ActedResult {
  id: string;
  title: string;
  pass: boolean;
  problems: string[];
  orders: { order_id: string; version: number; status: string; items: string[]; flags: string[] }[];
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_q, res) => reject(new Error(`endpoint refused: HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

/**
 * Run the scenarios against an in-process live service (dev routes on, raw
 * capture off). `checkItems` adds the item checks, for an extractor that reads
 * corrections (Gemini); the keyword extractor puts everything in review.
 */
export async function runActedScenarios(engine: Engine, opts: { only?: string[]; checkItems?: boolean; log?: (m: string) => void } = {}): Promise<ActedResult[]> {
  engine.cfg = { ...engine.cfg, tracker: { ...engine.cfg.tracker, ...SHORT_TIMERS } };
  const orders = new Map<string, OrderPayload[]>();
  const service = await startService(engine, {
    host: "127.0.0.1",
    port: 0,
    devRoutes: true,
    record: false,
    skipClockCheck: true,
    deliver: true,
    log: () => {},
    onUpdate: (lane, u: LaneUpdate) => {
      if (u.type === "order") orders.set(lane.laneId, [...(orders.get(lane.laneId) ?? []), u.payload]);
    },
  });
  const base = `ws://127.0.0.1:${service.server.address.port}/hme/v1/stream`;
  const results: ActedResult[] = [];
  try {
    for (const sc of ACTED_SCENARIOS.filter((s) => !opts.only || opts.only.includes(s.id))) {
      const storeId = "store_sim";
      const laneId = `sim_${sc.id}_${newId("l").slice(-6)}`;
      const t = issueTicket(engine.db, { storeId, laneId });
      const ws = await connect(`${base}?${new URLSearchParams({ lane: laneId, codec: "pcm_s16le", rate: "16000", channels: "1", ticket: t.ticket })}`);
      let open = true;
      for (const step of sc.steps) {
        if ("say" in step) {
          // The endpoint dates a typed line as if spoken (0.35 s a word, ending on arrival),
          // so the next line waits that long plus a turn gap; otherwise lines overlap.
          await sleep(step.text.split(/\s+/).length * 350 + 250);
          if (open) ws.send(JSON.stringify({ type: "utterance", speaker: step.say, text: step.text }));
        } else if ("event" in step) {
          if (open) ws.send(JSON.stringify({ type: step.event, at: new Date().toISOString() }));
          await sleep(100);
        } else if ("wait" in step) await sleep(step.wait);
        else {
          // A network failure, not a goodbye: no close handshake.
          ws.terminate();
          open = false;
        }
      }
      if (open) ws.close(1000);
      // Wait for extraction (an LLM call can take a few seconds).
      for (let i = 0; i < 60 && !(orders.get(laneId) ?? []).some((o) => o.order_version >= sc.expect.version); i++) await sleep(250);
      results.push(check(sc, orders.get(laneId) ?? [], opts.checkItems ?? false));
      opts.log?.(`${results.at(-1)?.pass ? "PASS" : "FAIL"} ${sc.title}${results.at(-1)?.problems.length ? `: ${results.at(-1)?.problems.join("; ")}` : ""}`);
    }
  } finally {
    await service.stop();
  }
  return results;
}

function check(sc: ActedScenario, sent: OrderPayload[], checkItems: boolean): ActedResult {
  const latest = new Map<string, OrderPayload>();
  for (const p of sent) if ((latest.get(p.order_id)?.order_version ?? 0) < p.order_version) latest.set(p.order_id, p);
  const final = [...latest.values()];
  const problems: string[] = [];
  const o = final[0];
  if (final.length !== 1 || !o) problems.push(`expected 1 order, got ${final.length}`);
  else {
    if (o.status !== sc.expect.status) problems.push(`status ${o.status}, expected ${sc.expect.status}`);
    if (o.order_version !== sc.expect.version) problems.push(`version ${o.order_version}, expected ${sc.expect.version}`);
    for (const f of sc.expect.flags ?? []) if (!o.flags.includes(f)) problems.push(`missing flag ${f}`);
    if (checkItems) {
      const ids = o.items.map((i) => i.catalog_id);
      for (const id of sc.expect.items ?? []) if (!ids.includes(id)) problems.push(`missing item ${id}`);
      for (const id of sc.expect.notItems ?? []) if (ids.includes(id)) problems.push(`unexpected item ${id}`);
    }
  }
  // Versions arrive in order, and none twice.
  const versions = sent.filter((p) => p.order_id === o?.order_id).map((p) => p.order_version);
  if (versions.join() !== [...new Set(versions)].sort((a, b) => a - b).join()) problems.push(`versions sent out of order or twice: ${versions.join(",")}`);
  return {
    id: sc.id,
    title: sc.title,
    pass: problems.length === 0,
    problems,
    orders: final.map((p) => ({ order_id: p.order_id, version: p.order_version, status: p.status, items: p.items.map((i) => i.catalog_id ?? i.name), flags: p.flags })),
  };
}
