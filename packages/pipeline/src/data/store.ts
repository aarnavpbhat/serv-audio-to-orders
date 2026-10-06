/**
 * Data store: keep everything (raw capture, conversation audio, Deepgram and
 * Gemini responses, events, labels) in a BlobStore, indexed in an SQLite
 * catalog. Every blob write inserts its catalog row. Orders, order versions,
 * outbox rows and delivery attempts live in their own tables and are never
 * hard-deleted; deleting data here removes blobs and marks catalog rows.
 *
 * Key layout (partitioned by store, lane and date everywhere):
 *   raw/store=<s>/lane=<l>/date=YYYY-MM-DD/session=<id>/part-00001.bin.zst (+ .index.ndjson, session.json)
 *   audio/.../order=<id>/v<version>.flac
 *   asr/.../session=<id>/deepgram-<n>.json
 *   llm/.../order=<id>/<request_hash>.json
 *   events/.../session=<id>/control.ndjson
 *   labels/.../order=<id>/<label_id>.json
 */
import { createHash } from "node:crypto";
import type { DB } from "../store/db";
import { newId } from "../lib/ids";
import { assertSafeId } from "../lib/safe-id";
import type { BlobStore } from "./blob-store";

export const ARTIFACT_KINDS = ["raw", "audio", "asr", "llm", "events", "labels"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  store_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  session_id TEXT,
  order_id TEXT,
  order_version INTEGER,
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  derived_from TEXT NOT NULL DEFAULT '[]',
  pipeline_version TEXT NOT NULL,
  model_ids TEXT NOT NULL DEFAULT '[]',
  retention_class TEXT NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS artifacts_order ON artifacts(order_id);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
CREATE INDEX IF NOT EXISTS artifacts_store ON artifacts(store_id, kind);
CREATE TABLE IF NOT EXISTS data_tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  artifacts INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  reason TEXT NOT NULL
);
`;

export interface ArtifactRow {
  id: string;
  kind: ArtifactKind;
  store_id: string;
  lane_id: string;
  session_id: string | null;
  order_id: string | null;
  order_version: number | null;
  uri: string;
  sha256: string;
  bytes: number;
  created_at: number;
  derived_from: string;
  pipeline_version: string;
  model_ids: string;
  retention_class: string;
  deleted_at: number | null;
}

export interface Partition {
  storeId: string;
  laneId: string;
  /** Any time on the recording's day (ISO); the partition uses its UTC date. */
  at: string;
}

const part = (p: Partition) =>
  `store=${assertSafeId("store", p.storeId)}/lane=${assertSafeId("lane", p.laneId)}/date=${new Date(Date.parse(p.at)).toISOString().slice(0, 10)}`;

/** Key builders; every id is checked before it becomes part of a key. */
export const keys = {
  raw: (p: Partition, sessionId: string, file: string) => `raw/${part(p)}/session=${assertSafeId("session", sessionId)}/${file}`,
  audio: (p: Partition, orderId: string, version: number) => `audio/${part(p)}/order=${assertSafeId("order", orderId)}/v${Math.trunc(version)}.flac`,
  asr: (p: Partition, sessionId: string, n: number) => `asr/${part(p)}/session=${assertSafeId("session", sessionId)}/deepgram-${Math.trunc(n)}.json`,
  llm: (p: Partition, orderId: string, requestHash: string) => `llm/${part(p)}/order=${assertSafeId("order", orderId)}/${assertSafeId("request hash", requestHash)}.json`,
  events: (p: Partition, sessionId: string) => `events/${part(p)}/session=${assertSafeId("session", sessionId)}/control.ndjson`,
  labels: (p: Partition, orderId: string, labelId: string) => `labels/${part(p)}/order=${assertSafeId("order", orderId)}/${assertSafeId("label", labelId)}.json`,
};

export interface ArtifactMeta {
  storeId: string;
  laneId: string;
  sessionId?: string | null;
  orderId?: string | null;
  orderVersion?: number | null;
  derivedFrom?: string[];
  modelIds?: string[];
  retentionClass?: string;
}

export interface DataStoreOptions {
  pipelineVersion: string;
  /** DATA_DISK_BUDGET_GB in bytes: warn at 80%, pause capture and archiving at 95%. */
  budgetBytes: number;
  /** keep_all (default): nothing is deleted on a schedule; prune and delete are manual. */
  retention: "keep_all";
  now?: () => number;
}

export type DiskState = "ok" | "warn" | "paused";

export interface Usage {
  byKind: Record<ArtifactKind, number>;
  total: number;
  budget: number;
  state: DiskState;
}

/** Bytes per kind (live artifacts) against a budget: ok, warn at 80%, paused at 95%. */
export function usageOf(db: DB, budgetBytes: number): Usage {
  const byKind = Object.fromEntries(ARTIFACT_KINDS.map((k) => [k, 0])) as Record<ArtifactKind, number>;
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'`).get();
  const rows = exists ? (db.prepare(`SELECT kind, SUM(bytes) AS b FROM artifacts WHERE deleted_at IS NULL GROUP BY kind`).all() as { kind: ArtifactKind; b: number }[]) : [];
  for (const r of rows) byKind[r.kind] = r.b;
  const total = rows.reduce((s, r) => s + r.b, 0);
  const ratio = total / Math.max(1, budgetBytes);
  return { byKind, total, budget: budgetBytes, state: ratio >= 0.95 ? "paused" : ratio >= 0.8 ? "warn" : "ok" };
}

/** Kinds the disk guard pauses: capture and archiving, never transcription, orders or webhooks. */
const PAUSABLE: ArtifactKind[] = ["raw", "audio"];

export class DataStore {
  private readonly now: () => number;
  private cachedUsage: { at: number; usage: Usage } | null = null;

  constructor(
    readonly db: DB,
    readonly blobs: BlobStore,
    readonly opts: DataStoreOptions,
  ) {
    db.exec(SCHEMA);
    this.now = opts.now ?? Date.now;
  }

  /** Bytes per kind (live artifacts), and where that sits against the budget. */
  usage(fresh = false): Usage {
    const t = this.now();
    if (!fresh && this.cachedUsage && t - this.cachedUsage.at < 5000) return this.cachedUsage.usage;
    const usage = usageOf(this.db, this.opts.budgetBytes);
    this.cachedUsage = { at: t, usage };
    return usage;
  }

  /** At 95% of the budget, raw capture and audio archiving stop (orders keep flowing). */
  capturePaused(): boolean {
    return this.usage().state === "paused";
  }

  /** Write a blob and its catalog row. Null when the disk guard has paused this kind. */
  async put(kind: ArtifactKind, key: string, data: Uint8Array | string, meta: ArtifactMeta): Promise<ArtifactRow | null> {
    if (PAUSABLE.includes(kind) && this.capturePaused()) return null;
    if (!key.startsWith(`${kind}/`)) throw new Error(`key ${key} is not a ${kind} key`);
    const res = await this.blobs.put(key, data);
    const row: ArtifactRow = {
      id: newId("art"),
      kind,
      store_id: meta.storeId,
      lane_id: meta.laneId,
      session_id: meta.sessionId ?? null,
      order_id: meta.orderId ?? null,
      order_version: meta.orderVersion ?? null,
      uri: res.uri,
      sha256: res.sha256,
      bytes: res.bytes,
      created_at: this.now(),
      derived_from: JSON.stringify(meta.derivedFrom ?? []),
      pipeline_version: this.opts.pipelineVersion,
      model_ids: JSON.stringify(meta.modelIds ?? []),
      retention_class: meta.retentionClass ?? this.opts.retention,
      deleted_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO artifacts (id, kind, store_id, lane_id, session_id, order_id, order_version, uri, sha256, bytes, created_at, derived_from, pipeline_version, model_ids, retention_class, deleted_at)
         VALUES (@id, @kind, @store_id, @lane_id, @session_id, @order_id, @order_version, @uri, @sha256, @bytes, @created_at, @derived_from, @pipeline_version, @model_ids, @retention_class, @deleted_at)`,
      )
      .run(row);
    if (this.cachedUsage) this.cachedUsage.usage.total += res.bytes;
    return row;
  }

  /** Everything recorded for an order (its audio, LLM calls, labels) and for its sessions. */
  find(q: { orderId?: string; sessionId?: string; storeId?: string; kind?: ArtifactKind; includeDeleted?: boolean }): ArtifactRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.orderId) {
      // The order's own artifacts, plus its sessions' (raw, asr, events).
      where.push(`(order_id = ? OR session_id IN (SELECT DISTINCT session_id FROM artifacts WHERE order_id = ? AND session_id IS NOT NULL))`);
      args.push(q.orderId, q.orderId);
    }
    if (q.sessionId) {
      where.push(`session_id = ?`);
      args.push(q.sessionId);
    }
    if (q.storeId) {
      where.push(`store_id = ?`);
      args.push(q.storeId);
    }
    if (q.kind) {
      where.push(`kind = ?`);
      args.push(q.kind);
    }
    if (!q.includeDeleted) where.push(`deleted_at IS NULL`);
    return this.db.prepare(`SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`).all(...args) as ArtifactRow[];
  }

  /** Delete by store, session or order: blobs removed, rows marked, one tombstone written. */
  async deleteWhere(scope: { storeId?: string; sessionId?: string; orderId?: string }, reason = "requested"): Promise<{ artifacts: number; bytes: number }> {
    const [field, value] = scope.storeId ? ["store_id", scope.storeId] : scope.sessionId ? ["session_id", scope.sessionId] : scope.orderId ? ["order_id", scope.orderId] : [null, null];
    if (!field || !value) throw new Error("delete needs --store, --session or --order");
    const rows = this.db.prepare(`SELECT * FROM artifacts WHERE ${field} = ? AND deleted_at IS NULL`).all(value) as ArtifactRow[];
    return this.remove(rows, field.replace("_id", ""), value, reason);
  }

  /** Delete one kind older than N days (built, not scheduled: RETENTION_POLICY=keep_all). */
  async prune(kind: ArtifactKind, olderThanDays: number): Promise<{ artifacts: number; bytes: number }> {
    const cutoff = this.now() - olderThanDays * 86_400_000;
    const rows = this.db.prepare(`SELECT * FROM artifacts WHERE kind = ? AND created_at < ? AND deleted_at IS NULL`).all(kind, cutoff) as ArtifactRow[];
    return this.remove(rows, "prune", `${kind}>${olderThanDays}d`, "retention");
  }

  private async remove(rows: ArtifactRow[], scope: string, value: string, reason: string): Promise<{ artifacts: number; bytes: number }> {
    const at = this.now();
    for (const r of rows) {
      await this.blobs.delete(r.uri);
      this.db.prepare(`UPDATE artifacts SET deleted_at = ? WHERE id = ?`).run(at, r.id);
    }
    const bytes = rows.reduce((s, r) => s + r.bytes, 0);
    this.db.prepare(`INSERT INTO data_tombstones (at, scope, value, artifacts, bytes, reason) VALUES (?, ?, ?, ?, ?, ?)`).run(at, scope, value, rows.length, bytes, reason);
    this.cachedUsage = null;
    return { artifacts: rows.length, bytes };
  }

  /** Re-hash a sample of blobs; report any that are missing or do not match their catalog hash. */
  async verify(sample = 50): Promise<{ checked: number; mismatches: { id: string; uri: string; problem: "missing" | "hash" }[] }> {
    const rows = this.db.prepare(`SELECT * FROM artifacts WHERE deleted_at IS NULL ORDER BY RANDOM() LIMIT ?`).all(sample) as ArtifactRow[];
    const mismatches: { id: string; uri: string; problem: "missing" | "hash" }[] = [];
    for (const r of rows) {
      if (!(await this.blobs.exists(r.uri))) {
        mismatches.push({ id: r.id, uri: r.uri, problem: "missing" });
        continue;
      }
      const h = createHash("sha256").update(await this.blobs.get(r.uri)).digest("hex");
      if (h !== r.sha256) mismatches.push({ id: r.id, uri: r.uri, problem: "hash" });
    }
    return { checked: rows.length, mismatches };
  }
}
