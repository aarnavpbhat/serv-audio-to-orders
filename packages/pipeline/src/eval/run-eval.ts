/** pnpm eval: run every fixture through the pipeline and score it against ground truth. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Engine } from "../engine";
import { DEFAULT_SCENARIO, type Scenario } from "../input/scenario";
import { replayFile } from "../lane/replay";
import type { StreamingTranscriber } from "../lane/types";
import { loadFixtureScripts } from "../fixtures/load";
import type { RunResult } from "../run";
import { FileOrLiveTranscriber } from "../lane/file-transcriber";
import type { ExpectedOrder, FixtureTimeline, NoiseLevel } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import { CHECKLIST } from "./checklist";
import { runLiveChecks, type LiveCheck } from "./live-checks";
import { compareOrders, passed, type OrderComparison } from "./compare";
import { samplePayload } from "../webhook/sample";
import { webhookSelfCheck, type WebhookCheck } from "./webhook-check";
import { latencySummary } from "../lane/replay";
import { loadWindowChanges, matchLayerB, POS_WINDOW_S, syntheticTicket, type LayerBMatch, type PosTicket, type WindowChange } from "./pos";

export interface EvalOptions {
  layout: "mono" | "stereo";
  only?: string[];
  compilations: boolean;
  deliver: boolean;
  webhook: boolean;
  scenario?: Scenario;
  /** Streaming transcriber (default: the engine's; files replay through the live path at max speed, plan D1). */
  streamingTranscriber?: StreamingTranscriber;
}

interface Target {
  id: string;
  title: string;
  covers: number[];
  noise: NoiseLevel;
  expected: { span: number; order: ExpectedOrder }[];
  compilation: boolean;
}

export interface FixtureReport {
  id: string;
  title: string;
  file: string;
  covers: number[];
  pass: boolean;
  error?: string;
  run_id?: string;
  segmentation: { expected: number; found: number; missed: number; extra: number; start_err_s: number[]; end_err_s: number[] };
  orders: { expected: number; produced: number; comparisons: (OrderComparison & { pass: boolean })[] };
  /** Layer B: our orders against the (synthetic) POS tickets. */
  layer_b?: LayerBMatch[];
  /** Live path only: what the lane did. */
  live?: { close_ms: number[]; close_by: Record<string, number[]>; reopens: number; expected_reopens: number; duplicate_versions: number };
  usage?: RunResult["usage"];
}

export interface EvalReport {
  generated_at: string;
  config: { layout: string; scenario: string | null; transcriber: string; extractor: string; model: string | null; menu_version: string };
  summary: {
    fixtures: number;
    fixtures_passed: number;
    item_precision: number;
    item_recall: number;
    bucket_accuracy: number;
    status_accuracy: number;
    review_accuracy: number;
    flags_accuracy: number;
    segmentation: { expected: number; found: number; missed: number; extra: number; mean_start_err_s: number; mean_end_err_s: number };
  };
  /** Layer B ("rung up"): orders against POS tickets. Synthetic tickets until Serv shares real ones. */
  layer_b: { tickets: number; matched: number; exact: number; exact_rate: number; extraction_error: number; window_change: number; unmatched: number; window_s: number; source: "synthetic" };
  /** Live-path metrics. Close latency at max speed is estimated: tracker lag on recording time plus processing time. */
  live: {
    close_latency_p50_ms: number;
    close_latency_p95_ms: number;
    /** By what closed the conversation (settled after a closing cue, idle timeout, vehicle departed, ...). */
    close_latency_by_trigger: Record<string, { orders: number; p50_ms: number; p95_ms: number }>;
    orders: number;
    reopen_rate: number;
    premature_reopens: number;
    duplicate_versions: number;
  } | null;
  rows: { row: number; title: string; fixtures: string[]; pass: boolean; detail?: string }[];
  fixtures: FixtureReport[];
  usage: { deepgram_minutes: number; llm_calls: number; llm_cached_calls: number; input_tokens: number; output_tokens: number };
}

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function targets(fixturesDir: string, opts: EvalOptions): Target[] {
  const scripts = loadFixtureScripts(path.join(fixturesDir, "scripts"));
  const out: Target[] = scripts.map((s) => ({
    id: s.id,
    title: s.title,
    covers: s.covers,
    noise: s.render.noise,
    compilation: false,
    // Split-payment orders share one conversation span.
    expected: s.expected.orders.map((order, i) => ({ span: s.events.length === s.expected.orders.length ? i : 0, order })),
  }));
  const compFile = path.join(fixturesDir, "compilations.json");
  if (opts.compilations && existsSync(compFile)) {
    const comps = JSON.parse(readFileSync(compFile, "utf8")) as { id: string; title: string; scripts: string[]; noise: NoiseLevel }[];
    for (const c of comps) {
      let span = 0;
      const expected: Target["expected"] = [];
      for (const sid of c.scripts) {
        const t = out.find((x) => x.id === sid);
        if (!t) continue;
        const spans = Math.max(...t.expected.map((e) => e.span)) + 1;
        for (const e of t.expected) expected.push({ span: span + e.span, order: e.order });
        span += spans;
      }
      out.push({ id: c.id, title: c.title, covers: [23], noise: c.noise, compilation: true, expected });
    }
  }
  return opts.only?.length ? out.filter((t) => opts.only?.includes(t.id)) : out;
}

function spansOf(timeline: FixtureTimeline): { start_s: number; end_s: number }[] {
  return [...new Map(timeline.orders.map((o) => [`${o.start_s}-${o.end_s}`, { start_s: o.start_s, end_s: o.end_s }])).values()];
}

async function evalTarget(engine: Engine, t: Target, opts: EvalOptions, changes: WindowChange[] = []): Promise<FixtureReport> {
  const file = path.join(engine.cfg.paths.fixturesDir, "audio", `${t.id}.${opts.layout}.${t.noise}.mp3`);
  const base: FixtureReport = {
    id: t.id,
    title: t.title,
    file: path.relative(engine.cfg.repoRoot, file),
    covers: t.covers,
    pass: false,
    segmentation: { expected: 0, found: 0, missed: 0, extra: 0, start_err_s: [], end_err_s: [] },
    orders: { expected: t.expected.length, produced: 0, comparisons: [] },
  };
  const timeline = existsSync(file) ? loadTimeline(file) : null;
  if (!timeline) return { ...base, error: `missing ${base.file}; run pnpm fixtures:build` };

  let laneRun: Awaited<ReturnType<typeof replayFile>> | null = null;
  let result: Pick<RunResult, "run_id" | "segmentation" | "orders" | "usage">;
  try {
    const transcriber = opts.streamingTranscriber ?? engine.streaming;
    const billedBefore = transcriber instanceof FileOrLiveTranscriber ? transcriber.billedMinutes : 0;
    const r = (laneRun = await replayFile(engine, file, {
      transcriber,
      scenario: { ...(opts.scenario ?? DEFAULT_SCENARIO), channels: opts.layout },
      deliver: opts.deliver,
      speed: "max",
    }));
    const billed = r.usage.deepgram_minutes + (transcriber instanceof FileOrLiveTranscriber ? transcriber.billedMinutes - billedBefore : 0);
    result = {
      run_id: r.run_id,
      segmentation: r.segmentation,
      orders: r.orders,
      usage: {
        stt: { provider: transcriber.name, audio_minutes: billed, cached: billed === 0, role_llm_calls: 0 },
        llm: r.usage.llm,
        segmentation_llm_calls: r.segmentation.llm_calls,
        gemini_today: r.usage.gemini_today ? { ...r.usage.gemini_today, tier: "unknown", exhausted: false } : null,
      },
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  const compareOpts = { lane: true, vehicleEvents: opts.scenario?.vehicle_events ?? ("off" as const) };

  const spans = spansOf(timeline);
  const segs = result.segmentation.segments;
  // Match each expected span to the produced segment it overlaps most.
  const used = new Set<string>();
  const matchFor = spans.map((sp) => {
    let best: (typeof segs)[number] | undefined;
    let bestOverlap = 0;
    for (const s of segs) {
      if (used.has(s.segment_id)) continue;
      const ov = Math.min(sp.end_s, s.end_s) - Math.max(sp.start_s, s.start_s);
      if (ov > bestOverlap) [best, bestOverlap] = [s, ov];
    }
    if (best) used.add(best.segment_id);
    return best;
  });
  const startErr: number[] = [];
  const endErr: number[] = [];
  matchFor.forEach((s, i) => {
    const sp = spans[i];
    if (!s || !sp) return;
    startErr.push(round(Math.abs(s.start_s - sp.start_s)));
    endErr.push(round(Math.abs(s.end_s - sp.end_s)));
  });
  const missed = matchFor.filter((s) => !s).length;
  const extra = segs.length - used.size;

  const comparisons: FixtureReport["orders"]["comparisons"] = [];
  let countsOk = true;
  spans.forEach((_, k) => {
    const exp = t.expected.filter((e) => e.span === k).map((e) => e.order);
    const seg = matchFor[k];
    const produced = seg ? result.orders.filter((o) => o.order.segment_id === seg.segment_id).map((o) => ({ ...o.order, version: o.payload.order_version })) : [];
    if (produced.length !== exp.length) countsOk = false;
    for (const c of compareOrders(engine.catalog, exp, produced, compareOpts)) comparisons.push({ ...c, pass: passed(c) });
    for (const extraOrder of produced.slice(exp.length)) {
      comparisons.push({
        checks: { items: false, needs_review: true, not_ordered: true, flags: true, status: true, review: true, group: true, declined_combo: true },
        item_tp: 0,
        item_fp: extraOrder.items.length,
        item_fn: 0,
        bucket_correct: 0,
        bucket_total: 0,
        diffs: [`unexpected extra order ${extraOrder.order_id}`],
        pass: false,
      });
    }
  });
  // Orders from segments that match no expected span are false positives.
  for (const s of segs.filter((x) => !used.has(x.segment_id))) {
    for (const o of result.orders.filter((x) => x.order.segment_id === s.segment_id)) {
      comparisons.push({
        checks: { items: false, needs_review: true, not_ordered: true, flags: true, status: true, review: true, group: true, declined_combo: true },
        item_tp: 0,
        item_fp: o.order.items.length,
        item_fn: 0,
        bucket_correct: 0,
        bucket_total: 0,
        diffs: [`extra segment ${s.segment_id} produced ${o.order.order_id}`],
        pass: false,
      });
    }
  }

  // Layer B: a ticket for each completed expected order, opened 10 s into its span.
  const start = Date.parse(timeline.recording_start_utc);
  const tickets: PosTicket[] = [];
  const expectedByTicket = new Map<string, ExpectedOrder>();
  t.expected.forEach((e, i) => {
    const sp = spans[e.span];
    if (!sp) return;
    const tk = syntheticTicket(
      engine.catalog,
      { fixture: t.id, index: i, order: e.order, start: new Date(start + sp.start_s * 1000).toISOString(), end: new Date(start + sp.end_s * 1000).toISOString(), storeId: engine.cfg.storeId.value, laneId: engine.cfg.laneId.value },
      changes,
    );
    if (tk) {
      tickets.push(tk);
      expectedByTicket.set(tk.ticket_id, e.order);
    }
  });
  const layerB = matchLayerB(engine.catalog, result.orders.map((o) => o.payload), tickets, (id) => expectedByTicket.get(id));

  return {
    ...base,
    run_id: result.run_id,
    layer_b: layerB,
    ...(laneRun ? { live: liveMetrics(laneRun, t) } : {}),
    pass: missed === 0 && extra === 0 && countsOk && comparisons.every((c) => c.pass),
    segmentation: { expected: spans.length, found: segs.length, missed, extra, start_err_s: startErr, end_err_s: endErr },
    orders: { expected: t.expected.length, produced: result.orders.length, comparisons },
    usage: result.usage,
  };
}

/** Close latency (estimated at max speed), reopens and duplicate versions for one lane replay. */
function liveMetrics(r: Awaited<ReturnType<typeof replayFile>>, t: Target): NonNullable<FixtureReport["live"]> {
  const finals = r.decisions.filter((d) => d.to === "FINALIZED").map((d) => ({ at: Date.parse(d.at), trigger: d.trigger }));
  const close_by: Record<string, number[]> = {};
  const close_ms = r.orders.flatMap((o) => {
    const end = Date.parse(o.payload.times.ended_at);
    const f = finals.filter((x) => x.at >= end - 1).sort((a, b) => a.at - b.at)[0];
    if (!f) return [];
    const ms = Math.round(f.at - end + o.payload.processing.latency_ms);
    (close_by[f.trigger] ??= []).push(ms);
    return [ms];
  });
  const seen = new Set<string>();
  let duplicate_versions = 0;
  for (const v of r.versions) {
    const k = `${v.payload.order_id}:${v.payload.order_version}`;
    if (seen.has(k)) duplicate_versions++;
    seen.add(k);
  }
  return {
    close_ms,
    close_by,
    reopens: r.versions.filter((v) => v.payload.correction_reason === "reopened_late_addition").length,
    expected_reopens: t.expected.filter((e) => (e.order.lane_version ?? 1) > 1).length,
    duplicate_versions,
  };
}

export async function runEval(engine: Engine, opts: EvalOptions, log: (m: string) => void = console.log): Promise<EvalReport> {
  const list = targets(engine.cfg.paths.fixturesDir, opts);
  const changes = loadWindowChanges(engine.cfg.paths.fixturesDir);
  const fixtures: FixtureReport[] = [];
  for (const t of list) {
    const r = await evalTarget(engine, t, opts, changes);
    fixtures.push(r);
    const diffs = r.error ? [r.error] : r.orders.comparisons.flatMap((c) => c.diffs);
    log(`${r.pass ? "PASS" : "FAIL"}  ${t.id}${diffs.length ? `\n        ${diffs.slice(0, 6).join("\n        ")}` : ""}`);
  }

  let webhook: WebhookCheck[] = [];
  if (opts.webhook) webhook = await webhookSelfCheck(samplePayload());
  // Live-path rows run when the eval goes through the lane (or when asked for explicitly).
  const live: LiveCheck[] = !opts.only?.length ? await runLiveChecks(engine) : [];

  const comps = fixtures.flatMap((f) => f.orders.comparisons);
  const tp = comps.reduce((s, c) => s + c.item_tp, 0);
  const fp = comps.reduce((s, c) => s + c.item_fp, 0);
  const fn = comps.reduce((s, c) => s + c.item_fn, 0);
  const real = comps.filter((c) => c.bucket_total > 0 || c.item_fn > 0);
  const seg = fixtures.map((f) => f.segmentation);

  const rows = CHECKLIST.map(({ row, title }) => {
    const wh = webhook.find((w) => w.row === row);
    if (wh) return { row, title, fixtures: ["webhook self-check"], pass: wh.pass, detail: wh.detail };
    if (row === 41) {
      // Window change: we heard it right (Layer A passes) and Layer B blames the window, not us.
      const wc = fixtures.filter((f) => changes.some((c) => c.fixture === f.id));
      const ok = wc.length > 0 && wc.every((f) => f.pass && (f.layer_b ?? []).some((m) => m.diffs.length > 0) && (f.layer_b ?? []).every((m) => m.diffs.every((d) => d.category === "window_change")));
      return { row, title, fixtures: wc.map((f) => f.id), pass: ok, ...(wc.length ? {} : { detail: "no window-change fixture in this run" }) };
    }
    const lc = live.find((c) => c.row === row);
    if (lc) return { row, title, fixtures: ["live check"], pass: lc.pass, detail: lc.detail };
    const covering = fixtures.filter((f) => f.covers.includes(row));
    if (row >= 29 && !covering.length) return { row, title, fixtures: [], pass: false, detail: opts.only?.length ? "not run with --only" : "not checked yet" };
    return { row, title, fixtures: covering.map((f) => f.id), pass: covering.length > 0 && covering.every((f) => f.pass) };
  });

  const usage = fixtures.reduce(
    (u, f) => ({
      deepgram_minutes: u.deepgram_minutes + (f.usage?.stt.cached ? 0 : (f.usage?.stt.audio_minutes ?? 0)),
      llm_calls: u.llm_calls + (f.usage?.llm.calls ?? 0),
      llm_cached_calls: u.llm_cached_calls + (f.usage?.llm.cached_calls ?? 0),
      input_tokens: u.input_tokens + (f.usage?.llm.input_tokens ?? 0),
      output_tokens: u.output_tokens + (f.usage?.llm.output_tokens ?? 0),
    }),
    { deepgram_minutes: 0, llm_calls: 0, llm_cached_calls: 0, input_tokens: 0, output_tokens: 0 },
  );

  const matches = fixtures.flatMap((f) => f.layer_b ?? []);
  const diffs = matches.flatMap((m) => m.diffs);
  const paired = matches.filter((m) => m.order_id && m.ticket_id);
  const lanes = fixtures.flatMap((f) => (f.live ? [f.live] : []));
  const closeMs = lanes.flatMap((l) => l.close_ms);
  const lat = latencySummary(closeMs);
  const reopens = lanes.reduce((s, l) => s + l.reopens, 0);

  const report: EvalReport = {
    generated_at: new Date().toISOString(),
    config: {
      layout: opts.layout,
      scenario: opts.scenario?.name ?? null,
      transcriber: (opts.streamingTranscriber ?? engine.streaming).name,
      extractor: engine.extractor.name,
      model: engine.gemini?.resolvedModel ?? engine.gemini?.model ?? null,
      menu_version: engine.catalog.version,
    },
    summary: {
      fixtures: fixtures.length,
      fixtures_passed: fixtures.filter((f) => f.pass).length,
      item_precision: round(tp + fp ? tp / (tp + fp) : 1),
      item_recall: round(tp + fn ? tp / (tp + fn) : 1),
      bucket_accuracy: round(real.reduce((s, c) => s + c.bucket_correct, 0) / Math.max(1, real.reduce((s, c) => s + c.bucket_total, 0))),
      status_accuracy: round(real.filter((c) => c.checks.status).length / Math.max(1, real.length)),
      review_accuracy: round(real.filter((c) => c.checks.review).length / Math.max(1, real.length)),
      flags_accuracy: round(real.filter((c) => c.checks.flags).length / Math.max(1, real.length)),
      segmentation: {
        expected: seg.reduce((s, x) => s + x.expected, 0),
        found: seg.reduce((s, x) => s + x.found, 0),
        missed: seg.reduce((s, x) => s + x.missed, 0),
        extra: seg.reduce((s, x) => s + x.extra, 0),
        mean_start_err_s: round(mean(seg.flatMap((x) => x.start_err_s)), 2),
        mean_end_err_s: round(mean(seg.flatMap((x) => x.end_err_s)), 2),
      },
    },
    layer_b: {
      tickets: matches.filter((m) => m.ticket_id).length,
      matched: paired.length,
      exact: paired.filter((m) => m.exact).length,
      exact_rate: round(paired.filter((m) => m.exact).length / Math.max(1, matches.filter((m) => m.ticket_id).length)),
      extraction_error: diffs.filter((d) => d.category === "extraction_error").length,
      window_change: diffs.filter((d) => d.category === "window_change").length,
      unmatched: diffs.filter((d) => d.category === "unmatched").length,
      window_s: POS_WINDOW_S,
      source: "synthetic",
    },
    live: lanes.length
      ? {
          close_latency_p50_ms: lat.close_latency_p50_ms ?? 0,
          close_latency_p95_ms: lat.close_latency_p95_ms ?? 0,
          close_latency_by_trigger: Object.fromEntries(
            [...new Set(lanes.flatMap((l) => Object.keys(l.close_by)))].map((k) => {
              const xs = lanes.flatMap((l) => l.close_by[k] ?? []);
              const q = latencySummary(xs);
              return [k, { orders: xs.length, p50_ms: q.close_latency_p50_ms ?? 0, p95_ms: q.close_latency_p95_ms ?? 0 }];
            }),
          ),
          orders: closeMs.length,
          reopen_rate: round(reopens / Math.max(1, closeMs.length)),
          premature_reopens: lanes.reduce((s, l) => s + Math.max(0, l.reopens - l.expected_reopens), 0),
          duplicate_versions: lanes.reduce((s, l) => s + l.duplicate_versions, 0),
        }
      : null,
    rows,
    fixtures,
    usage: { ...usage, deepgram_minutes: round(usage.deepgram_minutes) },
  };
  mkdirSync(engine.cfg.paths.evalDir, { recursive: true });
  writeFileSync(path.join(engine.cfg.paths.evalDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

export function formatReport(r: EvalReport): string {
  const s = r.summary;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "",
    `Eval: ${r.config.transcriber} + ${r.config.extractor} (${r.config.layout}${r.config.scenario ? `, scenario ${r.config.scenario}` : ""})`,
    "",
    "  Layer A (heard)",
    `  Fixtures passed     ${s.fixtures_passed}/${s.fixtures}`,
    `  Item precision      ${pct(s.item_precision)}`,
    `  Item recall         ${pct(s.item_recall)}`,
    `  Bucket accuracy     ${pct(s.bucket_accuracy)}`,
    `  Status accuracy     ${pct(s.status_accuracy)}`,
    `  Review exact match  ${pct(s.review_accuracy)}`,
    `  Flags exact match   ${pct(s.flags_accuracy)}`,
    `  Segments            ${s.segmentation.found} found / ${s.segmentation.expected} expected (missed ${s.segmentation.missed}, extra ${s.segmentation.extra})`,
    `  Boundary error      start ${s.segmentation.mean_start_err_s}s, end ${s.segmentation.mean_end_err_s}s (mean)`,
    "",
    `  Layer B (rung up, ${r.layer_b.source} POS tickets, ±${r.layer_b.window_s} s)`,
    `  Exact ticket match  ${r.layer_b.exact}/${r.layer_b.tickets} (${pct(r.layer_b.exact_rate)})`,
    `  Differences         ${r.layer_b.extraction_error} extraction error, ${r.layer_b.window_change} window change, ${r.layer_b.unmatched} unmatched`,
    ...(r.live
      ? [
          "",
          "  Live path",
          `  Close latency       p50 ${r.live.close_latency_p50_ms} ms, p95 ${r.live.close_latency_p95_ms} ms over ${r.live.orders} orders (estimated at max speed)`,
          ...Object.entries(r.live.close_latency_by_trigger).map(([k, v]) => `    ${k.replace(/_/g, " ").padEnd(18)}${v.orders} orders, p50 ${v.p50_ms} ms, p95 ${v.p95_ms} ms`),
          `  Reopens             ${pct(r.live.reopen_rate)} of orders, ${r.live.premature_reopens} premature`,
          `  Duplicate versions  ${r.live.duplicate_versions}`,
        ]
      : []),
    "",
    `  Usage               ${r.usage.deepgram_minutes} Deepgram min, ${r.usage.llm_calls} LLM calls (${r.usage.llm_cached_calls} cached), ${r.usage.input_tokens + r.usage.output_tokens} tokens`,
    "",
    "  Row  Case                                     Result",
    "  ---  ---------------------------------------  ------",
    ...r.rows.map((row) => `  ${String(row.row).padStart(3)}  ${row.title.padEnd(39)}  ${row.pass ? "pass" : "FAIL"}${row.detail ? `  (${row.detail})` : ""}`),
    "",
    "  Report written to eval/report.json",
  ];
  return lines.join("\n");
}
