/** Server-side reads shaped for the UI. */
import { readFileSync } from "node:fs";
import { getConfig, servSettings } from "@serv/config";
import {
  Catalog,
  dataUsage,
  groundTruthFor,
  scoreOrders,
  store,
  type AppliedEvent,
  type DataUsage,
  type EvalReport,
  type FolderReport,
  type GroundTruth,
  type Order,
  type OrderEvent,
  type OrderPayload,
  type Segmentation,
  type Transcript,
  type TruthRow,
} from "@serv/pipeline";
import { queuePosition } from "./jobs";

export function db() {
  return store.openDb(getConfig().paths.dbPath);
}

const parse = <T,>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

export interface RunSummary {
  id: string;
  created_at: number;
  source_file: string;
  status: string;
  stage: string | null;
  error: string | null;
  transcriber: string | null;
  extractor: string | null;
  duration_s: number | null;
  order_count: number;
  delivered: number;
  undelivered: number;
}

export function listRunSummaries(): RunSummary[] {
  const d = db();
  return store.listRuns(d, 100).map((r) => {
    const orders = store.ordersForRun(d, r.id);
    const outbox = store.outboxForRun(d, r.id);
    return {
      id: r.id,
      created_at: r.created_at,
      source_file: r.source_file,
      status: r.status,
      stage: r.stage,
      error: r.error,
      transcriber: r.transcriber,
      extractor: r.extractor,
      duration_s: parse<{ duration_s: number }>(r.audio)?.duration_s ?? null,
      order_count: orders.length,
      delivered: outbox.filter((o) => o.status === "delivered").length,
      undelivered: outbox.filter((o) => o.status !== "delivered").length,
    };
  });
}

export interface DeliveryView extends Omit<store.OutboxRow, "body"> {
  attempts: store.AttemptRow[];
}

export interface OrderVersionSummary {
  version: number;
  status: string;
  event_type: string;
  correction_reason: string | null;
  created_at: number;
}

export interface OrderView {
  order_id: string;
  /** Latest version first fields; earlier versions are summarized in `versions`. */
  version: number;
  versions: OrderVersionSummary[];
  segment_id: string;
  status: string;
  payload: OrderPayload;
  events: OrderEvent[];
  build_log: AppliedEvent[];
  extraction: { raw: unknown; repaired: boolean; fallback: boolean; warnings: string[] } | null;
  deliveries: DeliveryView[];
}

export interface RunDetail {
  id: string;
  created_at: number;
  source_file: string;
  status: string;
  stage: string | null;
  error: string | null;
  queue_position: number;
  transcriber: string | null;
  extractor: string | null;
  /** False for live lanes: their audio is in the archive per order, not one file. */
  has_audio: boolean;
  /** Expected vs extracted, for runs whose answer is known (fixtures; E6). Null when nobody knows the answer. */
  truth: TruthRow[] | null;
  options: Record<string, unknown> | null;
  transcript: Transcript | null;
  segmentation: Segmentation | null;
  usage: unknown;
  timings: Record<string, number> | null;
  orders: OrderView[];
}

export function getRunDetail(id: string): RunDetail | null {
  const d = db();
  const r = store.getRun(d, id);
  if (!r) return null;
  const outbox = store.outboxForRun(d, id);
  return {
    id: r.id,
    created_at: r.created_at,
    source_file: r.source_file,
    status: r.status,
    stage: r.stage,
    error: r.error,
    queue_position: queuePosition(id),
    transcriber: r.transcriber,
    extractor: r.extractor,
    has_audio: !!r.file_path,
    truth: runTruth(r, segmentationOf(r.segmentation), latestVersions(store.ordersForRun(d, id)).map(({ latest }) => latest)),
    options: parse(r.options),
    transcript: parse(r.transcript),
    segmentation: parse(r.segmentation),
    usage: parse(r.usage),
    timings: parse(r.timings),
    orders: latestVersions(store.ordersForRun(d, id)).map(({ latest: o, all }) => ({
      order_id: o.order_id,
      version: o.version,
      versions: all.map((v) => {
        const p = JSON.parse(v.payload) as Partial<OrderPayload>;
        return { version: v.version, status: v.status, event_type: p.event_type ?? "", correction_reason: p.correction_reason ?? null, created_at: v.created_at };
      }),
      segment_id: o.segment_id,
      status: o.status,
      payload: JSON.parse(o.payload) as OrderPayload,
      events: JSON.parse(o.events) as OrderEvent[],
      build_log: parse<AppliedEvent[]>(o.build_log) ?? [],
      extraction: parse(o.extraction),
      deliveries: outbox
        .filter((x) => x.order_id === o.order_id)
        .map(({ body: _body, ...rest }) => ({ ...rest, attempts: store.attemptsFor(d, rest.webhook_id) })),
    })),
  };
}

/** One entry per order: its latest version plus every version in order. */
function latestVersions(rows: store.OrderRow[]): { latest: store.OrderRow; all: store.OrderRow[] }[] {
  const by = new Map<string, store.OrderRow[]>();
  for (const r of rows) by.set(r.order_id, [...(by.get(r.order_id) ?? []), r]);
  return [...by.values()].map((all) => {
    const sorted = [...all].sort((a, b) => a.version - b.version);
    return { latest: sorted[sorted.length - 1] as store.OrderRow, all: sorted };
  });
}

export function runAudioPath(id: string): string | null {
  // Live lanes have no file (empty path).
  return store.getRun(db(), id)?.file_path || null;
}

export function readEvalReport(): EvalReport | null {
  try {
    return JSON.parse(readFileSync(`${getConfig().paths.evalDir}/report.json`, "utf8")) as EvalReport;
  } catch {
    return null;
  }
}

export function settings() {
  const cfg = getConfig();
  return {
    serv: servSettings(cfg),
    keys: { deepgram: !!cfg.deepgramApiKey, gemini: !!cfg.geminiApiKey },
    geminiModel: cfg.geminiModel,
    language: cfg.language,
    data: dataUsage(db(), cfg.data.budgetBytes) satisfies DataUsage,
  };
}

export function menuJson(): unknown {
  return JSON.parse(readFileSync(getConfig().paths.menu, "utf8"));
}

export interface ReviewOrder {
  payload: OrderPayload;
  run_id: string;
  created_at: number;
  /** Audio to play: the order's archive (live) or its run's file (uploads). */
  clip?: boolean;
}

/** Latest version of every order that still needs a person's review, newest first. */
export function ordersNeedingReview(limit = 100): ReviewOrder[] {
  const rows = db()
    .prepare(
      `SELECT o.payload, o.run_id, o.created_at FROM orders o
       JOIN (SELECT order_id, MAX(version) AS v FROM orders GROUP BY order_id) m ON m.order_id = o.order_id AND m.v = o.version
       ORDER BY o.created_at DESC LIMIT 2000`,
    )
    .all() as { payload: string; run_id: string; created_at: number }[];
  const flagged = rows.map((r) => ({ payload: JSON.parse(r.payload) as OrderPayload, run_id: r.run_id, created_at: r.created_at })).filter((r) => r.payload.review?.required);
  // E5, E6: only orders nobody knows the answer to; fixture runs are scored against their script instead.
  const known = truthRuns([...new Set(flagged.map((r) => r.run_id))]);
  const d = db();
  return flagged
    .filter((r) => !known.has(r.run_id))
    .slice(0, limit)
    .map((r) => ({ ...r, clip: !!r.payload.audio_ref.archive_uri || !!store.getRun(d, r.run_id)?.file_path }));
}

/** The held-out set's own report (scored apart from the main eval), if it has been run. */
export function readHeldoutReport(): FolderReport | null {
  try {
    return JSON.parse(readFileSync(`${getConfig().paths.evalDir}/heldout-report.json`, "utf8")) as FolderReport;
  } catch {
    return null;
  }
}

const segmentationOf = (s: string | null) => parse<Segmentation>(s);

/** Ground truth per fixture file (scripts and timeline are read once). */
const truthCache = new Map<string, GroundTruth | null>();
function truthForFile(file: string | null | undefined): GroundTruth | null {
  if (!file) return null;
  if (!truthCache.has(file)) truthCache.set(file, groundTruthFor(getConfig().paths.fixturesDir, file));
  return truthCache.get(file) ?? null;
}

/** E6: a run with a known answer (fixture audio) is scored automatically, never sent to a person. */
export function hasGroundTruth(run: Pick<store.RunRow, "file_path"> | undefined): boolean {
  return !!truthForFile(run?.file_path);
}

function runTruth(run: store.RunRow, segmentation: Segmentation | null, latest: store.OrderRow[]): TruthRow[] | null {
  const truth = truthForFile(run.file_path);
  if (!truth || !segmentation) return null;
  const produced = latest.map((o) => {
    const payload = JSON.parse(o.payload) as OrderPayload;
    // Only the fields the comparison reads: the payload carries all of them but the segment.
    return { payload, order: { ...payload, segment_id: o.segment_id } as unknown as Order };
  });
  return scoreOrders(Catalog.fromJson(menuJson()), truth, segmentation.segments, produced, { lane: true }).rows;
}

/** Runs with a known answer, by id (cached per request batch). */
function truthRuns(runIds: string[]): Set<string> {
  const d = db();
  return new Set(runIds.filter((id) => hasGroundTruth(store.getRun(d, id))));
}

/** E5: the review queue's size (sidebar badge). */
export function reviewQueueCount(): number {
  return ordersNeedingReview(1000).length;
}

export interface OrderFilters {
  status?: string;
  review?: "yes" | "no";
  store?: string;
  lane?: string;
  /** YYYY-MM-DD, local day the order started. */
  date?: string;
}

export interface OrderListRow {
  payload: OrderPayload;
  run_id: string;
  created_at: number;
}

/** Every order's latest version, newest first, filtered (the read-only Orders page). */
export function listOrders(f: OrderFilters, limit = 300): OrderListRow[] {
  const rows = db()
    .prepare(
      `SELECT o.payload, o.run_id, o.created_at FROM orders o
       JOIN (SELECT order_id, MAX(version) AS v FROM orders GROUP BY order_id) m ON m.order_id = o.order_id AND m.v = o.version
       ORDER BY o.created_at DESC LIMIT 5000`,
    )
    .all() as { payload: string; run_id: string; created_at: number }[];
  const day = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  return rows
    .map((r) => ({ payload: JSON.parse(r.payload) as OrderPayload, run_id: r.run_id, created_at: r.created_at }))
    // Orders from before schema 2.0 (v1 sandbox runs) have a different shape; they are not listed.
    .filter(({ payload: p }) => p.schema_version === "2.0")
    .filter(({ payload: p }) => (!f.status || p.status === f.status) && (!f.review || p.review.required === (f.review === "yes")) && (!f.store || p.store_id === f.store) && (!f.lane || p.lane_id === f.lane) && (!f.date || day(p.times.started_at) === f.date))
    .slice(0, limit);
}
