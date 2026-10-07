/**
 * Test Lab scorecard (v2.1 step 7): did the system get the scenario right, and
 * if not, which part failed?
 *
 * Attribution: the scenario is replayed with the script's exact words (a perfect
 * transcript) through the same tracker and extractor, in a throwaway database.
 * A difference the perfect run does not have was "heard wrong" (transcription).
 * One it has too was "understood wrong" (extraction), unless the live run lost an
 * item the perfect run at least noticed (heard wrong). An order that is missing,
 * extra or not reopened is "timing" (the tracker split or closed it wrongly).
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DataStore } from "../data/store";
import { LocalBlobStore } from "../data/blob-store";
import type { Engine } from "../engine";
import { compareOrders, passed } from "../eval/compare";
import type { TruthRow } from "../eval/ground-truth";
import type { SourceMessage } from "../input/types";
import { LaneManager } from "../lane/manager";
import { ScriptStreamingTranscriber } from "../lane/script-transcriber";
import type { ExpectedOrder, Order, OrderPayload } from "../schemas";
import { isSafeId } from "../lib/safe-id";
import { openDb } from "../store/db";
import { z } from "zod";
import { actionsAt, type Scenario } from "./scenario";

export type Attribution = "heard wrong" | "understood wrong" | "timing";

export interface ProducedOrder {
  order: Order;
  payload: OrderPayload;
}

export interface Scorecard {
  pass: boolean;
  rows: TruthRow[];
  /** One label per difference, by row index and diff text. */
  attribution: { row: number; diff: string; where: Attribution }[];
  /** Word error rate against the script, per role (0 is perfect; null when the role said nothing). */
  wer: { customer: number | null; crew: number | null };
  /** Share of heard lines labeled with the right speaker (null when no line matched the script). */
  roleAccuracy: number | null;
  /** Conversation end to order sent, ms (median over orders; null when nothing was sent). */
  speedMs: number | null;
}

const BASE = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (s: number) => new Date(BASE + s * 1000).toISOString();

/**
 * The scenario read perfectly: script lines as final utterances, with the same
 * car and connection actions, through a throwaway engine (its own database and
 * data store, nothing delivered). Returns the latest version of each order.
 */
export async function perfectRun(engine: Engine, s: Scenario): Promise<ProducedOrder[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "serv-testlab-"));
  const db = openDb(path.join(dir, "perfect.db"));
  const shadow: Engine = {
    ...engine,
    db,
    data: new DataStore(db, new LocalBlobStore(path.join(dir, "blobs")), { pipelineVersion: engine.cfg.pipelineVersion, budgetBytes: 1024 ** 3, retention: "keep_all" }),
    log: () => {},
  };
  try {
    const manager = new LaneManager({ engine: shadow, transcriber: new ScriptStreamingTranscriber(), runId: "testlab_perfect", deliver: false });
    const t = engine.cfg.tracker;
    let session = 1;
    let now = 0;
    const send = (m: SourceMessage) => manager.handle(m);
    const sid = () => `ses_perfect_${session}`;
    const open = () => send({ kind: "session_open", session: { sessionId: sid(), storeId: "testlab", laneId: "perfect", sourceType: "hme_ws", audio: { sampleRate: 16000, channels: 1 }, timeBasis: "receive_clock", anchorAt: iso(now), codecIn: "pcm_s16le" } });
    const act = async (point: "start" | "end" | number) => {
      for (const a of actionsAt(s, point)) {
        now += 0.5;
        if (a.do === "drop") {
          await send({ kind: "session_close", sessionId: sid(), at: iso(now), reason: "remote_close" });
          if (a.seconds) {
            now += a.seconds;
            session++;
            await open();
          } else {
            // Gone for good: the grace period runs out.
            now += t.reconnectGraceS + 1;
            await send({ kind: "tick", at: iso(now) });
          }
        } else await send({ kind: "control", event: { sessionId: sid(), at: iso(now), type: a.do === "car_arrived" ? "vehicle_arrived" : "vehicle_departed" } });
      }
    };
    await open();
    await act("start");
    for (const [i, line] of s.lines.entries()) {
      if (line.wait_for === "order_sent") {
        now += t.closeSettleS + 2;
        await send({ kind: "tick", at: iso(now) });
      }
      now += Math.max(1.2, line.text.split(/\s+/).length * 0.35) + 0.8;
      await send({ kind: "script_line", line: { sessionId: sid(), speaker: line.role, text: line.text, at: iso(now) } });
      await act(i + 1 === s.lines.length ? "end" : i + 1);
    }
    now += Math.max(t.closeSettleS, t.reopenWindowS) + 5;
    await send({ kind: "tick", at: iso(now) });
    await manager.end();
    return [...manager.lanes.values()].flatMap((l) => l.latestOrders).map((o) => ({ order: o.order, payload: o.payload }));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Expected orders against produced ones, in time order; produced orders beyond the expected count are extra. */
export function compareInOrder(engine: Engine, expected: ExpectedOrder[], produced: ProducedOrder[]): TruthRow[] {
  const sorted = [...produced].sort((a, b) => Date.parse(a.payload.times.started_at) - Date.parse(b.payload.times.started_at));
  const comps = compareOrders(
    engine.catalog,
    expected,
    sorted.map((o) => ({ ...o.order, version: o.payload.order_version })),
    { lane: true },
  );
  const rows: TruthRow[] = comps.map((c, i) => ({ span: null, segmentId: sorted[i]?.order.segment_id ?? null, expected: expected[i] ?? null, actual: sorted[i]?.payload ?? null, comparison: { ...c, pass: passed(c) } }));
  for (const extra of sorted.slice(expected.length)) {
    rows.push({
      span: null,
      segmentId: extra.order.segment_id,
      expected: null,
      actual: extra.payload,
      comparison: {
        checks: { items: false, needs_review: true, not_ordered: true, flags: true, status: true, review: true, group: true, declined_combo: true },
        item_tp: 0,
        item_fp: extra.payload.items.length,
        item_fn: 0,
        bucket_correct: 0,
        bucket_total: 0,
        diffs: [`unexpected extra order ${extra.payload.order_id}`],
        pass: false,
      },
    });
  }
  return rows;
}

/** Catalog ids an order mentions anywhere (ordered, unclear with candidates, or not ordered). */
function mentions(p: OrderPayload | null): Set<string> {
  if (!p) return new Set();
  return new Set([...p.items.map((i) => i.catalog_id), ...p.needs_review.flatMap((n) => [n.catalog_id, ...n.candidates.map((c) => c.catalog_id)]), ...p.not_ordered.map((n) => n.catalog_id)].filter((x): x is string => !!x));
}

export function attribute(live: TruthRow[], perfect: TruthRow[], expectedCount: number): Scorecard["attribution"] {
  const out: Scorecard["attribution"] = [];
  const liveCount = live.filter((r) => r.actual).length;
  live.forEach((row, i) => {
    const twin = perfect[i];
    for (const diff of row.comparison.diffs) {
      let where: Attribution;
      if (diff === "order missing" || diff.startsWith("unexpected extra order") || diff.startsWith("order_version") || liveCount !== expectedCount) where = "timing";
      else if (!twin?.comparison.diffs.includes(diff)) where = "heard wrong";
      else {
        // Both runs miss it; if only the live run lost all trace of the item, it was not heard.
        const item = /^missing item ([^|]+)\|/.exec(diff)?.[1];
        where = item && mentions(twin.actual).has(item) && !mentions(row.actual).has(item) ? "heard wrong" : "understood wrong";
      }
      out.push({ row: i, diff, where });
    }
  });
  return out;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Word-level edit distance over the reference length. */
export function wordErrorRate(reference: string, hypothesis: string): number | null {
  const r = words(reference);
  const h = words(hypothesis);
  if (!r.length) return null;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.round(((prev[h.length] ?? 0) / r.length) * 1000) / 1000;
}

/** Each heard line matched to the script line it shares most words with (at least half); right speaker or not. */
export function roleAccuracy(script: { role: "crew" | "customer"; text: string }[], heard: { speaker: "crew" | "customer"; text: string }[]): number | null {
  let matched = 0;
  let right = 0;
  for (const u of heard) {
    const hw = new Set(words(u.text));
    let best: (typeof script)[number] | null = null;
    let bestScore = 0;
    for (const l of script) {
      const lw = new Set(words(l.text));
      const inter = [...hw].filter((w) => lw.has(w)).length;
      const score = inter / Math.max(1, new Set([...hw, ...lw]).size);
      if (score > bestScore) [best, bestScore] = [l, score];
    }
    if (!best || bestScore < 0.5) continue;
    matched++;
    if (best.role === u.speaker) right++;
  }
  return matched ? Math.round((right / matched) * 1000) / 1000 : null;
}

export function scoreRun(
  engine: Engine,
  input: {
    expected: ExpectedOrder[];
    live: ProducedOrder[];
    /** Null for free play without a script (no attribution). */
    perfect: ProducedOrder[] | null;
    script: { role: "crew" | "customer"; text: string }[];
    heard: { speaker: "crew" | "customer"; text: string }[];
    /** Conversation end to order sent, per order, ms. */
    sendDelaysMs: number[];
  },
): Scorecard {
  const rows = compareInOrder(engine, input.expected, input.live);
  const perfectRows = input.perfect ? compareInOrder(engine, input.expected, input.perfect) : [];
  const byRole = (role: "crew" | "customer") =>
    wordErrorRate(
      input.script.filter((l) => l.role === role).map((l) => l.text).join(" "),
      input.heard.filter((u) => u.speaker === role).map((u) => u.text).join(" "),
    );
  const delays = [...input.sendDelaysMs].sort((a, b) => a - b);
  return {
    pass: rows.length === input.expected.length && rows.every((r) => r.comparison.pass),
    rows,
    attribution: input.perfect ? attribute(rows, perfectRows, input.expected.length) : [],
    wer: { customer: byRole("customer"), crew: byRole("crew") },
    roleAccuracy: roleAccuracy(input.script, input.heard),
    speedMs: delays.length ? (delays[Math.floor(delays.length / 2)] ?? null) : null,
  };
}

/** The scoring request from the Test Lab page (validated at the web route). */
export const ScoreRequestBody = z.object({
  scenarioId: z.string().regex(/^[a-z0-9_]+$/).optional(),
  /** Free play: what was actually ordered, picked from the menu by the tester. */
  expected: z
    .array(
      z.object({
        status: z.enum(["completed", "cancelled", "abandoned", "undetermined"]),
        items: z.array(z.object({ catalog_id: z.string().max(64), quantity: z.number().int().min(1).max(50), size: z.enum(["small", "medium", "large"]).nullable().optional() })).max(40),
      }),
    )
    .max(20)
    .optional(),
  storeId: z.string().refine(isSafeId),
  laneId: z.string().refine(isSafeId),
  /** When the run started (wall ms). */
  since: z.number().int().nonnegative(),
  testerMode: z.enum(["both", "robot", "two"]),
  input: z.enum(["mic", "text"]),
});
export type ScoreRequestBody = z.infer<typeof ScoreRequestBody>;

/** A free-play answer as expected orders (no flags, review or not-ordered lines asked of the tester). */
export function freePlayExpected(answer: NonNullable<ScoreRequestBody["expected"]>): ExpectedOrder[] {
  return answer.map((o) => ({
    status: o.status,
    items: o.items.map((i) => ({ catalog_id: i.catalog_id, quantity: i.quantity, ...(i.size !== undefined ? { size: i.size } : {}) })),
    needs_review: [],
    not_ordered: [],
    flags: [],
    review: [],
    group: null,
  }));
}
