/** Server-side reads shaped for the UI. */
import { readFileSync } from "node:fs";
import { getConfig, servSettings } from "@serv/config";
import { dataUsage, store, type DataUsage, type EvalReport, type OrderEvent, type OrderPayload, type Segmentation, type Transcript, type AppliedEvent } from "@serv/pipeline";
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
  return store.getRun(db(), id)?.file_path ?? null;
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
