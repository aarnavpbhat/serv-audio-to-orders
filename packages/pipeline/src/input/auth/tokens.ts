/**
 * Per-store ingest tokens: sit_<tokenId>_<secret>. tokenId is 12 random base32
 * characters; the secret is 32 random bytes, base64url. Only the secret's
 * SHA-256 is stored, and the secret is never logged.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "../../store/db";
import { assertSafeId } from "../../lib/safe-id";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOKEN_PATTERN = /^sit_([A-Z2-7]{12})_([A-Za-z0-9_-]{43})$/;

export const TOKEN_SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_tokens (
  token_id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  allowed_lanes TEXT NOT NULL,
  secret_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS ingest_tickets (
  ticket_sha256 TEXT PRIMARY KEY,
  store_id TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS ingest_auth_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  ip TEXT NOT NULL,
  token_id TEXT,
  result TEXT NOT NULL,
  reason TEXT
);
`;

export interface TokenRow {
  token_id: string;
  store_id: string;
  allowed_lanes: string;
  secret_sha256: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  note: string | null;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Constant-time comparison of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function tokenId(): string {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => BASE32[b % 32]).join("");
}

export function ensureTokenTables(db: DB): void {
  db.exec(TOKEN_SCHEMA);
}

/** Create a token; the full token is returned once and never stored. */
export function createToken(db: DB, opts: { storeId: string; lanes: string[]; note?: string; now?: number }): { token: string; tokenId: string } {
  ensureTokenTables(db);
  assertSafeId("store", opts.storeId);
  if (!opts.lanes.length) throw new Error("At least one lane is required");
  for (const l of opts.lanes) assertSafeId("lane", l);
  const id = tokenId();
  const secret = randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO ingest_tokens (token_id, store_id, allowed_lanes, secret_sha256, created_at, note) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    opts.storeId,
    JSON.stringify(opts.lanes),
    sha256(secret),
    opts.now ?? Date.now(),
    opts.note ?? null,
  );
  return { token: `sit_${id}_${secret}`, tokenId: id };
}

export function listTokens(db: DB): Omit<TokenRow, "secret_sha256">[] {
  ensureTokenTables(db);
  return db.prepare(`SELECT token_id, store_id, allowed_lanes, created_at, revoked_at, last_used_at, note FROM ingest_tokens ORDER BY created_at`).all() as Omit<TokenRow, "secret_sha256">[];
}

export function revokeToken(db: DB, id: string, now = Date.now()): boolean {
  ensureTokenTables(db);
  return db.prepare(`UPDATE ingest_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL`).run(now, id).changes === 1;
}

export function isRevoked(db: DB, id: string): boolean {
  const row = db.prepare(`SELECT revoked_at FROM ingest_tokens WHERE token_id = ?`).get(id) as { revoked_at: number | null } | undefined;
  return !row || row.revoked_at !== null;
}

/** One-time ticket for the dev simulator (browsers cannot set WebSocket headers). 60 s, single use, bound to store and lane. */
export function issueTicket(db: DB, opts: { storeId: string; laneId: string; ttlMs?: number; now?: number }): { ticket: string; expiresAt: number } {
  ensureTokenTables(db);
  assertSafeId("store", opts.storeId);
  assertSafeId("lane", opts.laneId);
  const now = opts.now ?? Date.now();
  const ticket = `tkt_${randomBytes(32).toString("base64url")}`;
  const expiresAt = now + (opts.ttlMs ?? 60_000);
  db.prepare(`DELETE FROM ingest_tickets WHERE expires_at < ?`).run(now - 3600_000);
  db.prepare(`INSERT INTO ingest_tickets (ticket_sha256, store_id, lane_id, expires_at) VALUES (?, ?, ?, ?)`).run(sha256(ticket), opts.storeId, opts.laneId, expiresAt);
  return { ticket, expiresAt };
}

/** Uses up a ticket. Null when unknown, expired or already used. */
export function redeemTicket(db: DB, ticket: string, now = Date.now()): { storeId: string; laneId: string } | null {
  ensureTokenTables(db);
  if (!/^tkt_[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const hash = sha256(ticket);
  const used = db.prepare(`UPDATE ingest_tickets SET used_at = ? WHERE ticket_sha256 = ? AND used_at IS NULL AND expires_at >= ?`).run(now, hash, now).changes === 1;
  if (!used) return null;
  const row = db.prepare(`SELECT store_id, lane_id FROM ingest_tickets WHERE ticket_sha256 = ?`).get(hash) as { store_id: string; lane_id: string };
  return { storeId: row.store_id, laneId: row.lane_id };
}
