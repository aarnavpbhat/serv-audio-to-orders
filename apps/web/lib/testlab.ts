/** Test Lab server side: scenarios, scoring a finished run against its script, and the results history. */
import path from "node:path";
import { getConfig } from "@serv/config";
import { createEngine, loadScenarios, perfectRun, scoreRun, store, type Order, type OrderPayload, type Scenario, type Scorecard } from "@serv/pipeline";
import type { ExpectedOrder } from "@serv/pipeline/schemas/index";
import { db } from "./data";

export function scenarios(): Scenario[] {
  const engine = createEngine({ transcriber: "script", extractor: "fuzzy", log: () => {} });
  return loadScenarios(path.join(getConfig().repoRoot, "testlab/scenarios"), engine.catalog);
}

export interface ScoreRequest {
  scenarioId?: string;
  /** Free play: what was actually ordered (the tester's answer). */
  expected?: ExpectedOrder[];
  storeId: string;
  laneId: string;
  /** When the run started (wall ms). */
  since: number;
  testerMode: string;
  input: string;
}

export interface ScoreResponse extends Scorecard {
  id: string;
  scenarioId: string;
  stt: string;
  extractor: string;
}

/** Latest version of each order sent on this lane since the run started. */
function liveOrders(storeId: string, laneId: string, since: number): { order: Order; payload: OrderPayload; created_at: number }[] {
  const rows = db()
    .prepare(
      `SELECT o.payload, o.segment_id, o.created_at FROM orders o
       JOIN (SELECT order_id, MAX(version) AS v FROM orders GROUP BY order_id) m ON m.order_id = o.order_id AND m.v = o.version
       WHERE o.created_at >= ? ORDER BY o.created_at`,
    )
    .all(since - 1000) as { payload: string; segment_id: string; created_at: number }[];
  return rows
    .map((r) => ({ payload: JSON.parse(r.payload) as OrderPayload, segment_id: r.segment_id, created_at: r.created_at }))
    .filter((r) => r.payload.store_id === storeId && r.payload.lane_id === laneId)
    .map((r) => ({ payload: r.payload, order: { ...r.payload, segment_id: r.segment_id } as unknown as Order, created_at: r.created_at }));
}

/** Every final line heard on the lane since the run started (live view feed). */
function heardLines(storeId: string, laneId: string, since: number): { speaker: "crew" | "customer"; text: string }[] {
  const rows = db().prepare(`SELECT data FROM live_events WHERE store_id = ? AND lane_id = ? AND type = 'utterance' AND at >= ? ORDER BY id`).all(storeId, laneId, since - 1000) as { data: string }[];
  return rows.map((r) => (JSON.parse(r.data) as { utterance: { speaker: "crew" | "customer"; text: string } }).utterance);
}

export async function scoreTestRun(req: ScoreRequest): Promise<ScoreResponse> {
  const scenario = req.scenarioId ? scenarios().find((s) => s.id === req.scenarioId) : undefined;
  if (req.scenarioId && !scenario) throw new Error(`No scenario ${req.scenarioId}`);
  const expected = scenario?.expected.orders ?? req.expected ?? [];
  if (!expected.length) throw new Error("Say what was actually ordered first");
  // The perfect-words replay uses the same extractor as the live service would (Gemini when a key is set).
  const engine = createEngine({ transcriber: "script", log: () => {} });
  const live = liveOrders(req.storeId, req.laneId, req.since);
  const d = db();
  const sendDelaysMs = live.flatMap(({ payload }) => {
    const sent = store.outboxForOrder(d, payload.order_id).find((o) => o.order_version === 1 && o.delivered_at);
    return sent?.delivered_at ? [sent.delivered_at - Date.parse(payload.times.ended_at)] : [];
  });
  const card = scoreRun(engine, {
    expected,
    live,
    perfect: scenario ? await perfectRun(engine, scenario) : null,
    script: scenario?.lines ?? [],
    heard: heardLines(req.storeId, req.laneId, req.since),
    sendDelaysMs,
  });
  const stt = live[0]?.payload.processing.stt ?? (req.input === "text" ? "typed" : "unknown");
  const extractor = live[0]?.payload.processing.extractor ?? engine.extractor.name;
  const id = `tl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  store.insertTestlabResult(d, {
    id,
    created_at: Date.now(),
    scenario_id: scenario?.id ?? "free_play",
    tester_mode: req.testerMode,
    input: req.input,
    stt,
    extractor,
    pass: card.pass ? 1 : 0,
    wer_customer: card.wer.customer,
    wer_crew: card.wer.crew,
    role_accuracy: card.roleAccuracy,
    speed_ms: card.speedMs,
    detail: JSON.stringify({ ...card, laneId: req.laneId, since: req.since }),
  });
  return { ...card, id, scenarioId: scenario?.id ?? "free_play", stt, extractor };
}

export interface HistoryRow {
  scenario: string;
  runs: number;
  passRate: number;
  werCustomer: number | null;
  werCrew: number | null;
  roleAccuracy: number | null;
  speedMs: number | null;
}

const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Results grouped by scenario, filtered by tester mode and model. */
export function history(filter: { testerMode?: string; stt?: string }): { rows: HistoryRow[]; results: store.TestlabResultRow[]; modes: string[]; models: string[] } {
  const all = store.listTestlabResults(db());
  const results = all.filter((r) => (!filter.testerMode || r.tester_mode === filter.testerMode) && (!filter.stt || r.stt === filter.stt));
  const names = new Map(scenarios().map((s) => [s.id, `${s.number}. ${s.title}`]));
  const by = new Map<string, store.TestlabResultRow[]>();
  for (const r of results) by.set(r.scenario_id, [...(by.get(r.scenario_id) ?? []), r]);
  const rows = [...by.entries()]
    .map(([id, rs]) => ({
      scenario: names.get(id) ?? (id === "free_play" ? "Free play" : id),
      runs: rs.length,
      passRate: rs.filter((r) => r.pass).length / rs.length,
      werCustomer: avg(rs.map((r) => r.wer_customer)),
      werCrew: avg(rs.map((r) => r.wer_crew)),
      roleAccuracy: avg(rs.map((r) => r.role_accuracy)),
      speedMs: avg(rs.map((r) => r.speed_ms)),
    }))
    .sort((a, b) => a.scenario.localeCompare(b.scenario, undefined, { numeric: true }));
  return { rows, results, modes: [...new Set(all.map((r) => r.tester_mode))].sort(), models: [...new Set(all.map((r) => r.stt))].sort() };
}
