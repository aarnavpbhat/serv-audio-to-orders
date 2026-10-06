/**
 * The human-voiced held-out set (plan D8): recordings of real people (saved
 * from the simulator, or phone recordings imported here), each with an
 * expected order written and checked by hand. It is scored on its own, into
 * its own report, and never feeds the main eval or any tuning: prompts, cues
 * and thresholds are never changed because of it.
 *
 *   fixtures/heldout/<name>/audio.flac      the recording, 16 kHz mono
 *   fixtures/heldout/<name>/expected.json   { orders: [{ status, items: [{ catalog_id, quantity, size }] }] }
 *   fixtures/heldout/<name>/timeline.json   where it came from (simulator or phone import)
 *
 * The same runner scores fixtures/live/ (simulator recordings that are not held out).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Engine } from "../engine";
import { decodeFileCanonical, encodeFlac } from "../input/encoders";
import { mixdown } from "../input/pcm";
import { CANONICAL_RATE } from "../input/types";
import { replayFile } from "../lane/replay";
import type { StreamingTranscriber } from "../lane/types";
import { assertSafeId } from "../lib/safe-id";
import type { OrderPayload } from "../schemas";
import { ExpectedOrder } from "../sim/save-fixture";

export type FolderSet = "heldout" | "live";

export const FolderExpected = z.object({ orders: z.array(ExpectedOrder) });

export interface FolderFixture {
  name: string;
  dir: string;
  audio: string;
  expected: z.infer<typeof FolderExpected>;
  /** expected.json could not be read; the recording is reported, not scored. */
  invalid?: string;
}

export function listFolderFixtures(fixturesDir: string, set: FolderSet): FolderFixture[] {
  const root = path.join(fixturesDir, set);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = path.join(root, d.name);
      const audio = path.join(dir, "audio.flac");
      const exp = path.join(dir, "expected.json");
      if (!existsSync(audio) || !existsSync(exp)) return [];
      let parsed: ReturnType<typeof FolderExpected.safeParse> | null = null;
      try {
        parsed = FolderExpected.safeParse(JSON.parse(readFileSync(exp, "utf8")));
      } catch {
        parsed = null;
      }
      if (parsed?.success) return [{ name: d.name, dir, audio, expected: parsed.data }];
      return [{ name: d.name, dir, audio, expected: { orders: [] }, invalid: parsed ? parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 200) : "not valid JSON" }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Import a phone recording as a held-out fixture: converted to 16 kHz mono
 * FLAC, with an expected.json to fill in by hand before it counts.
 */
export async function importRecording(fixturesDir: string, file: string, name: string, set: FolderSet = "heldout"): Promise<{ dir: string; seconds: number }> {
  const root = path.join(fixturesDir, set);
  const dir = path.join(root, assertSafeId("fixture", name));
  const channels = await decodeFileCanonical(file, 1);
  const mono = channels.length > 1 ? mixdown(channels) : (channels[0] ?? new Int16Array(0));
  if (!mono.length) throw new Error(`No audio in ${path.basename(file)}`);
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`A fixture named ${name} already exists`);
    throw e;
  }
  writeFileSync(path.join(dir, "audio.flac"), await encodeFlac([mono]));
  const seconds = Math.round((mono.length / CANONICAL_RATE) * 10) / 10;
  writeFileSync(path.join(dir, "timeline.json"), JSON.stringify({ source: "phone_import", original_file: path.basename(file), audio_s: seconds, imported_at: new Date().toISOString() }, null, 2) + "\n");
  writeFileSync(
    path.join(dir, "expected.json"),
    JSON.stringify({ name, held_out: set === "heldout", written_by: "hand", note: "Fill in one order per car, in order, from listening to the recording. Catalog ids are in menu/menu.json.", orders: [] }, null, 2) + "\n",
  );
  return { dir, seconds };
}

const itemKey = (catalog: Engine["catalog"], i: { catalog_id: string; quantity: number; size?: string | null }) =>
  `${i.catalog_id}|${i.size === undefined || i.size === null ? (catalog.sizeFor(i.catalog_id, null) ?? "-") : i.size}|x${i.quantity}`;

export interface FolderResult {
  name: string;
  pass: boolean;
  expected_orders: number;
  produced_orders: number;
  item_tp: number;
  item_fp: number;
  item_fn: number;
  status_correct: number;
  diffs: string[];
  error?: string;
}

export interface FolderReport {
  generated_at: string;
  set: FolderSet;
  note: string;
  config: { transcriber: string; extractor: string };
  summary: { fixtures: number; passed: number; item_precision: number; item_recall: number; status_accuracy: number; orders_expected: number; orders_produced: number };
  fixtures: FolderResult[];
  usage: { deepgram_minutes: number; llm_calls: number };
}

function score(engine: Engine, f: FolderFixture, produced: OrderPayload[]): FolderResult {
  const orders = [...produced].sort((a, b) => Date.parse(a.times.started_at) - Date.parse(b.times.started_at));
  const res: FolderResult = { name: f.name, pass: false, expected_orders: f.expected.orders.length, produced_orders: orders.length, item_tp: 0, item_fp: 0, item_fn: 0, status_correct: 0, diffs: [] };
  if (orders.length !== f.expected.orders.length) res.diffs.push(`expected ${f.expected.orders.length} order(s), got ${orders.length}`);
  const n = Math.max(orders.length, f.expected.orders.length);
  for (let i = 0; i < n; i++) {
    const exp = f.expected.orders[i];
    const got = orders[i];
    const want = (exp?.items ?? []).map((x) => itemKey(engine.catalog, x));
    const pool = (got?.items ?? []).map((x) => itemKey(engine.catalog, x));
    for (const k of want) {
      const j = pool.indexOf(k);
      if (j >= 0) {
        pool.splice(j, 1);
        res.item_tp++;
      } else {
        res.item_fn++;
        res.diffs.push(`order ${i + 1}: missing ${k}`);
      }
    }
    res.item_fp += pool.length;
    for (const k of pool) res.diffs.push(`order ${i + 1}: extra ${k}`);
    if (exp && got && exp.status === got.status) res.status_correct++;
    else if (exp && got) res.diffs.push(`order ${i + 1}: status ${got.status}, expected ${exp.status}`);
  }
  res.pass = res.diffs.length === 0;
  return res;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Score a folder set (held out, or simulator recordings) through the live path. Writes eval/<set>-report.json. */
export async function runFolderEval(engine: Engine, opts: { set: FolderSet; transcriber?: StreamingTranscriber; log?: (m: string) => void } ): Promise<FolderReport> {
  const transcriber = opts.transcriber ?? engine.streaming;
  const list = listFolderFixtures(engine.cfg.paths.fixturesDir, opts.set);
  const results: FolderResult[] = [];
  let minutes = 0;
  let llm = 0;
  for (const f of list) {
    if (f.invalid) {
      results.push({ name: f.name, pass: false, expected_orders: 0, produced_orders: 0, item_tp: 0, item_fp: 0, item_fn: 0, status_correct: 0, diffs: [], error: `expected.json is not valid: ${f.invalid}` });
      continue;
    }
    if (!f.expected.orders.length) {
      results.push({ name: f.name, pass: false, expected_orders: 0, produced_orders: 0, item_tp: 0, item_fp: 0, item_fn: 0, status_correct: 0, diffs: [], error: "expected.json has no orders yet (fill it in by hand first)" });
      continue;
    }
    try {
      const r = await replayFile(engine, f.audio, { transcriber, deliver: false, speed: "max", storeId: `store_${opts.set}`, laneId: assertSafeId("lane", f.name) });
      minutes += r.usage.deepgram_minutes;
      llm += r.usage.llm.calls;
      results.push(score(engine, f, r.orders.map((o) => o.payload)));
    } catch (e) {
      results.push({ name: f.name, pass: false, expected_orders: f.expected.orders.length, produced_orders: 0, item_tp: 0, item_fp: 0, item_fn: 0, status_correct: 0, diffs: [], error: (e as Error).message.slice(0, 300) });
    }
    const last = results.at(-1);
    opts.log?.(`${last?.pass ? "PASS" : "FAIL"}  ${f.name}${last?.error ? `  ${last.error}` : last?.diffs.length ? `\n        ${last.diffs.slice(0, 6).join("\n        ")}` : ""}`);
  }
  const tp = results.reduce((s, r) => s + r.item_tp, 0);
  const fp = results.reduce((s, r) => s + r.item_fp, 0);
  const fn = results.reduce((s, r) => s + r.item_fn, 0);
  const expectedOrders = results.reduce((s, r) => s + r.expected_orders, 0);
  const report: FolderReport = {
    generated_at: new Date().toISOString(),
    set: opts.set,
    note: opts.set === "heldout" ? "Held out: never used to tune prompts, cues or thresholds. Reported apart from the main eval." : "Simulator recordings (not held out).",
    config: { transcriber: transcriber.name, extractor: engine.extractor.name },
    summary: {
      fixtures: results.length,
      passed: results.filter((r) => r.pass).length,
      item_precision: round(tp + fp ? tp / (tp + fp) : 1),
      item_recall: round(tp + fn ? tp / (tp + fn) : 1),
      status_accuracy: round(results.reduce((s, r) => s + r.status_correct, 0) / Math.max(1, expectedOrders)),
      orders_expected: expectedOrders,
      orders_produced: results.reduce((s, r) => s + r.produced_orders, 0),
    },
    fixtures: results,
    usage: { deepgram_minutes: round(minutes), llm_calls: llm },
  };
  mkdirSync(engine.cfg.paths.evalDir, { recursive: true });
  writeFileSync(path.join(engine.cfg.paths.evalDir, `${opts.set}-report.json`), JSON.stringify(report, null, 2) + "\n");
  return report;
}

/** Total audio in a folder set, to show the Deepgram cost before a real run. */
export async function folderAudioMinutes(fixturesDir: string, set: FolderSet): Promise<number> {
  let s = 0;
  for (const f of listFolderFixtures(fixturesDir, set)) s += ((await decodeFileCanonical(f.audio, 1))[0]?.length ?? 0) / CANONICAL_RATE;
  return Math.round((s / 60) * 10) / 10;
}
