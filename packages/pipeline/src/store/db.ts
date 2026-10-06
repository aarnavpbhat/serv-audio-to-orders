/** SQLite store: runs, orders, webhook outbox and attempts, and the mock receiver's inbox. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_file TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT,
  status TEXT NOT NULL,
  stage TEXT,
  error TEXT,
  options TEXT,
  audio TEXT,
  transcript TEXT,
  segmentation TEXT,
  usage TEXT,
  timings TEXT,
  transcriber TEXT,
  extractor TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  events TEXT NOT NULL,
  extraction TEXT,
  build_log TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (order_id, version)
);
CREATE INDEX IF NOT EXISTS orders_run ON orders(run_id);
CREATE TABLE IF NOT EXISTS outbox (
  webhook_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_version INTEGER NOT NULL,
  run_id TEXT,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_status_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  error TEXT,
  response_body TEXT,
  retry_after_s REAL
);
CREATE INDEX IF NOT EXISTS attempts_webhook ON attempts(webhook_id);
CREATE TABLE IF NOT EXISTS mock_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  webhook_id TEXT,
  attempt TEXT,
  signature_ok INTEGER NOT NULL,
  verify_reason TEXT,
  duplicate INTEGER NOT NULL,
  status_returned INTEGER NOT NULL,
  mode TEXT NOT NULL,
  headers TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_orders (
  order_id TEXT PRIMARY KEY,
  order_version INTEGER NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS live_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  store_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  retry_after_s INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const handles = new Map<string, DB>();

export function openDb(file: string): DB {
  const existing = handles.get(file);
  if (existing?.open) return existing;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  handles.set(file, db);
  return db;
}

// ------------------------------------------------------------------ runs

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface RunRow {
  id: string;
  created_at: number;
  updated_at: number;
  source_file: string;
  file_path: string;
  file_hash: string | null;
  status: RunStatus;
  stage: string | null;
  error: string | null;
  options: string | null;
  audio: string | null;
  transcript: string | null;
  segmentation: string | null;
  usage: string | null;
  timings: string | null;
  transcriber: string | null;
  extractor: string | null;
}

export function insertRun(db: DB, run: { id: string; source_file: string; file_path: string; options: unknown }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, created_at, updated_at, source_file, file_path, status, stage, options) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?)`,
  ).run(run.id, now, now, run.source_file, run.file_path, JSON.stringify(run.options));
}

const RUN_JSON_FIELDS = ["audio", "transcript", "segmentation", "usage", "timings", "options"] as const;
type RunPatch = Partial<Omit<RunRow, "id" | "created_at" | (typeof RUN_JSON_FIELDS)[number]>> &
  Partial<Record<(typeof RUN_JSON_FIELDS)[number], unknown>>;

export function updateRun(db: DB, id: string, patch: RunPatch): void {
  const entries = Object.entries(patch).map(([k, v]) => [
    k,
    (RUN_JSON_FIELDS as readonly string[]).includes(k) && v !== null && typeof v !== "string" ? JSON.stringify(v) : v,
  ]);
  if (!entries.length) return;
  const sets = [...entries.map(([k]) => `${k} = ?`), "updated_at = ?"].join(", ");
  db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v as string | number | null), Date.now(), id);
}

export function getRun(db: DB, id: string): RunRow | undefined {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
}

export function listRuns(db: DB, limit = 50): Omit<RunRow, "transcript" | "segmentation">[] {
  return db
    .prepare(
      `SELECT id, created_at, updated_at, source_file, file_path, file_hash, status, stage, error, options, audio, usage, timings, transcriber, extractor FROM runs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Omit<RunRow, "transcript" | "segmentation">[];
}

// ---------------------------------------------------------------- orders

export interface OrderRow {
  order_id: string;
  version: number;
  run_id: string;
  segment_id: string;
  status: string;
  payload: string;
  events: string;
  extraction: string | null;
  build_log: string | null;
  created_at: number;
}

export function insertOrder(db: DB, row: Omit<OrderRow, "created_at">): void {
  db.prepare(
    `INSERT INTO orders (order_id, version, run_id, segment_id, status, payload, events, extraction, build_log, created_at)
     VALUES (@order_id, @version, @run_id, @segment_id, @status, @payload, @events, @extraction, @build_log, @created_at)`,
  ).run({ ...row, created_at: Date.now() });
}

export function ordersForRun(db: DB, runId: string): OrderRow[] {
  return db.prepare(`SELECT * FROM orders WHERE run_id = ? ORDER BY created_at, order_id`).all(runId) as OrderRow[];
}

/** Next version number for an order (1 when it has none yet). Versions are never deleted. */
export function nextOrderVersion(db: DB, orderId: string): number {
  const row = db.prepare(`SELECT MAX(version) AS v FROM orders WHERE order_id = ?`).get(orderId) as { v: number | null };
  return (row.v ?? 0) + 1;
}

export function orderVersions(db: DB, orderId: string): OrderRow[] {
  return db.prepare(`SELECT * FROM orders WHERE order_id = ? ORDER BY version`).all(orderId) as OrderRow[];
}

export function latestOrder(db: DB, orderId: string): OrderRow | undefined {
  return db.prepare(`SELECT * FROM orders WHERE order_id = ? ORDER BY version DESC LIMIT 1`).get(orderId) as OrderRow | undefined;
}

// ---------------------------------------------------------------- outbox

/** waiting: a later order version held until every earlier version is delivered, failed or dead. */
export type OutboxStatus = "pending" | "waiting" | "delivering" | "delivered" | "failed" | "dead";

export interface OutboxRow {
  webhook_id: string;
  order_id: string;
  order_version: number;
  run_id: string | null;
  url: string;
  body: string;
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: number | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

export interface AttemptRow {
  id: number;
  webhook_id: string;
  attempt: number;
  phase: "fast" | "slow" | "manual";
  started_at: number;
  latency_ms: number | null;
  status_code: number | null;
  error: string | null;
  response_body: string | null;
  retry_after_s: number | null;
}

export function getOutbox(db: DB, webhookId: string): OutboxRow | undefined {
  return db.prepare(`SELECT * FROM outbox WHERE webhook_id = ?`).get(webhookId) as OutboxRow | undefined;
}

export function outboxForRun(db: DB, runId: string): OutboxRow[] {
  return db.prepare(`SELECT * FROM outbox WHERE run_id = ? ORDER BY created_at`).all(runId) as OutboxRow[];
}

export function outboxForOrder(db: DB, orderId: string): OutboxRow[] {
  return db.prepare(`SELECT * FROM outbox WHERE order_id = ? ORDER BY order_version DESC`).all(orderId) as OutboxRow[];
}

export function dueOutbox(db: DB, now = Date.now()): OutboxRow[] {
  return db
    .prepare(`SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at`)
    .all(now) as OutboxRow[];
}

export function attemptsFor(db: DB, webhookId: string): AttemptRow[] {
  return db.prepare(`SELECT * FROM attempts WHERE webhook_id = ? ORDER BY attempt`).all(webhookId) as AttemptRow[];
}

// ------------------------------------------------------------ mock inbox

export type MockMode = "ok" | "fail_500" | "rate_limit_429" | "timeout";

export interface MockSettings {
  mode: MockMode;
  /** Requests left to fail before returning to ok. -1 = keep failing. */
  remaining: number;
  retry_after_s: number;
}

export function getMockSettings(db: DB): MockSettings {
  const row = db.prepare(`SELECT mode, remaining, retry_after_s FROM mock_settings WHERE id = 1`).get() as MockSettings | undefined;
  return row ?? { mode: "ok", remaining: 0, retry_after_s: 3 };
}

export function setMockSettings(db: DB, s: MockSettings): void {
  db.prepare(
    `INSERT INTO mock_settings (id, mode, remaining, retry_after_s, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, remaining = excluded.remaining, retry_after_s = excluded.retry_after_s, updated_at = excluded.updated_at`,
  ).run(s.mode, s.remaining, s.retry_after_s, Date.now());
}

export interface MockInboxRow {
  id: number;
  received_at: number;
  webhook_id: string | null;
  attempt: string | null;
  signature_ok: number;
  verify_reason: string | null;
  duplicate: number;
  status_returned: number;
  mode: string;
  headers: string;
  body: string;
}

/** What the mock receiver kept: the highest version per order_id. */
export interface MockOrderRow {
  order_id: string;
  order_version: number;
  webhook_id: string;
  status: string | null;
  body: string;
  received_at: number;
}

export function listMockOrders(db: DB, limit = 200): MockOrderRow[] {
  return db.prepare(`SELECT * FROM mock_orders ORDER BY received_at DESC LIMIT ?`).all(limit) as MockOrderRow[];
}

export function listMockInbox(db: DB, limit = 100): MockInboxRow[] {
  return db.prepare(`SELECT * FROM mock_inbox ORDER BY id DESC LIMIT ?`).all(limit) as MockInboxRow[];
}
