/** pnpm eval: run every fixture through the pipeline and score it against ground truth. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Engine } from "../engine";
import type { Scenario } from "../input/scenario";
import { replayFile } from "../lane/replay";
import { ScriptStreamingTranscriber } from "../lane/script-transcriber";
import type { StreamingTranscriber } from "../lane/types";
import { loadFixtureScripts } from "../fixtures/load";
import { runPipeline, type RunResult } from "../run";
import type { ExpectedOrder, FixtureTimeline, NoiseLevel, Order } from "../schemas";
import { loadTimeline } from "../transcribe/script";
import { CHECKLIST } from "./checklist";
import { runLiveChecks, type LiveCheck } from "./live-checks";
import { compareOrders, passed, type OrderComparison } from "./compare";
import { samplePayload } from "../webhook/sample";
import { webhookSelfCheck, type WebhookCheck } from "./webhook-check";

export interface EvalOptions {
  layout: "mono" | "stereo";
  only?: string[];
  compilations: boolean;
  deliver: boolean;
  webhook: boolean;
  /** file: v1 batch path. lane: replay through the live path at max speed (plan D1). */
  via?: "file" | "lane";
  scenario?: Scenario;
  /** Streaming transcriber for --via lane (default: the free script transcriber). */
  streamingTranscriber?: StreamingTranscriber;
}

interface Target {
  id: string;
  liveOnly?: boolean;
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
  usage?: RunResult["usage"];
}

export interface EvalReport {
  generated_at: string;
  config: { layout: string; via: string; scenario: string | null; transcriber: string; extractor: string; model: string | null; menu_version: string };
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
    liveOnly: s.live_only,
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
  const runnable = opts.via === "lane" ? out : out.filter((t) => !t.liveOnly);
  return opts.only?.length ? runnable.filter((t) => opts.only?.includes(t.id)) : runnable;
}

function spansOf(timeline: FixtureTimeline): { start_s: number; end_s: number }[] {
  return [...new Map(timeline.orders.map((o) => [`${o.start_s}-${o.end_s}`, { start_s: o.start_s, end_s: o.end_s }])).values()];
}

async function evalTarget(engine: Engine, t: Target, opts: EvalOptions): Promise<FixtureReport> {
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

  let result: Pick<RunResult, "run_id" | "segmentation" | "orders" | "usage">;
  try {
    if (opts.via === "lane") {
      const r = await replayFile(engine, file, {
        transcriber: opts.streamingTranscriber ?? new ScriptStreamingTranscriber(),
        ...(opts.scenario ? { scenario: { ...opts.scenario, channels: opts.layout } } : {}),
        deliver: opts.deliver,
        speed: "max",
      });
      result = {
        run_id: r.run_id,
        segmentation: r.segmentation,
        orders: r.orders,
        usage: {
          stt: { provider: opts.streamingTranscriber?.name ?? "script/ground-truth", audio_minutes: r.usage.deepgram_minutes, cached: false, role_llm_calls: 0 },
          llm: r.usage.llm,
          segmentation_llm_calls: r.segmentation.llm_calls,
          gemini_today: r.usage.gemini_today ? { ...r.usage.gemini_today, tier: "unknown", exhausted: false } : null,
        },
      };
    } else {
      result = await runPipeline(engine, file, {
        channelMap: opts.layout === "stereo" ? { 0: "customer", 1: "crew" } : null,
        audioStartUtc: "2026-10-03T18:40:00Z",
        deliver: opts.deliver,
      });
    }
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  const compareOpts = { lane: opts.via === "lane", vehicleEvents: opts.via === "lane" ? (opts.scenario?.vehicle_events ?? "off") : ("off" as const) };

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

  return {
    ...base,
    run_id: result.run_id,
    pass: missed === 0 && extra === 0 && countsOk && comparisons.every((c) => c.pass),
    segmentation: { expected: spans.length, found: segs.length, missed, extra, start_err_s: startErr, end_err_s: endErr },
    orders: { expected: t.expected.length, produced: result.orders.length, comparisons },
    usage: result.usage,
  };
}

export async function runEval(engine: Engine, opts: EvalOptions, log: (m: string) => void = console.log): Promise<EvalReport> {
  const list = targets(engine.cfg.paths.fixturesDir, opts);
  const fixtures: FixtureReport[] = [];
  for (const t of list) {
    const r = await evalTarget(engine, t, opts);
    fixtures.push(r);
    const diffs = r.error ? [r.error] : r.orders.comparisons.flatMap((c) => c.diffs);
    log(`${r.pass ? "PASS" : "FAIL"}  ${t.id}${diffs.length ? `\n        ${diffs.slice(0, 6).join("\n        ")}` : ""}`);
  }

  let webhook: WebhookCheck[] = [];
  if (opts.webhook) webhook = await webhookSelfCheck(samplePayload());
  // Live-path rows run when the eval goes through the lane (or when asked for explicitly).
  const live: LiveCheck[] = opts.via === "lane" && !opts.only?.length ? await runLiveChecks(engine) : [];

  const comps = fixtures.flatMap((f) => f.orders.comparisons);
  const tp = comps.reduce((s, c) => s + c.item_tp, 0);
  const fp = comps.reduce((s, c) => s + c.item_fp, 0);
  const fn = comps.reduce((s, c) => s + c.item_fn, 0);
  const real = comps.filter((c) => c.bucket_total > 0 || c.item_fn > 0);
  const seg = fixtures.map((f) => f.segmentation);

  const rows = CHECKLIST.map(({ row, title }) => {
    const wh = webhook.find((w) => w.row === row);
    if (wh) return { row, title, fixtures: ["webhook self-check"], pass: wh.pass, detail: wh.detail };
    const lc = live.find((c) => c.row === row);
    if (lc) return { row, title, fixtures: ["live check"], pass: lc.pass, detail: lc.detail };
    const covering = fixtures.filter((f) => f.covers.includes(row));
    if (row >= 29 && !covering.length) return { row, title, fixtures: [], pass: false, detail: opts.via === "lane" ? "not checked yet" : "run with --via lane" };
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

  const report: EvalReport = {
    generated_at: new Date().toISOString(),
    config: {
      layout: opts.layout,
      via: opts.via ?? "file",
      scenario: opts.scenario?.name ?? null,
      transcriber: opts.via === "lane" ? (opts.streamingTranscriber?.name ?? "script/ground-truth") : engine.transcriber.name,
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
    `Eval: ${r.config.transcriber} + ${r.config.extractor} (${r.config.layout}, via ${r.config.via ?? "file"}${r.config.scenario ? `, scenario ${r.config.scenario}` : ""})`,
    "",
    `  Fixtures passed     ${s.fixtures_passed}/${s.fixtures}`,
    `  Item precision      ${pct(s.item_precision)}`,
    `  Item recall         ${pct(s.item_recall)}`,
    `  Bucket accuracy     ${pct(s.bucket_accuracy)}`,
    `  Status accuracy     ${pct(s.status_accuracy)}`,
    `  Review exact match  ${pct(s.review_accuracy)}`,
    `  Flags exact match   ${pct(s.flags_accuracy)}`,
    `  Segments            ${s.segmentation.found} found / ${s.segmentation.expected} expected (missed ${s.segmentation.missed}, extra ${s.segmentation.extra})`,
    `  Boundary error      start ${s.segmentation.mean_start_err_s}s, end ${s.segmentation.mean_end_err_s}s (mean)`,
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
