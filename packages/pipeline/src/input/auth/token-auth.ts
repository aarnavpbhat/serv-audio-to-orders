/**
 * TokenAuth: checks an ingest token (or, with dev routes on, a one-time ticket)
 * before a WebSocket upgrade is accepted.
 *   1. More than 10 failed attempts from one IP in a minute -> 429.
 *   2. "Authorization: Bearer <token>"; ?token= only when INGEST_AUTH_ALLOW_QUERY=true.
 *   3. Look up by token id, hash the secret, compare in constant time. Unknown,
 *      malformed, wrong secret or revoked all get the same 401, with no detail.
 *   4. The lane comes from ?lane= and must be allowed; the store only from the token.
 * Every attempt is logged (time, IP, token id, result, reason), never the secret.
 */
import type { DB } from "../../store/db";
import { isSafeId } from "../../lib/safe-id";
import { digestsEqual, ensureTokenTables, redeemTicket, sha256, TOKEN_PATTERN, type TokenRow } from "./tokens";
import type { AuthFailure, AuthResult, IngestAuth, IngestRequest } from "./types";

export interface TokenAuthOptions {
  allowQueryToken: boolean;
  /** Dev routes on: accept ?ticket= from the simulator. */
  allowTickets: boolean;
  maxFailuresPerMinute?: number;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

/** Same body for every 401, so a caller cannot tell which check failed. */
export const UNAUTHORIZED = "unauthorized";

export class TokenAuth implements IngestAuth {
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(
    private readonly db: DB,
    private readonly opts: TokenAuthOptions,
  ) {
    ensureTokenTables(db);
    this.now = opts.now ?? Date.now;
  }

  authenticate(req: IngestRequest): AuthResult {
    const now = this.now();
    const recent = (this.failures.get(req.ip) ?? []).filter((t) => now - t < 60_000);
    this.failures.set(req.ip, recent);
    if (recent.length >= (this.opts.maxFailuresPerMinute ?? 10)) return this.done(req, null, { ok: false, status: 429, reason: "rate_limited" });

    const ticket = req.query.get("ticket");
    if (ticket !== null) {
      if (!this.opts.allowTickets) return this.fail(req, null, "tickets_disabled");
      const t = redeemTicket(this.db, ticket, now);
      if (!t) return this.fail(req, null, "ticket_invalid");
      return this.done(req, "ticket", { ok: true, storeId: t.storeId, allowedLanes: [t.laneId], laneId: t.laneId, tokenId: "ticket" });
    }

    const header = req.headers.authorization;
    const bearer = typeof header === "string" && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : null;
    const fromQuery = req.query.get("token");
    if (!bearer && fromQuery !== null && !this.opts.allowQueryToken) return this.fail(req, null, "query_not_allowed");
    const raw = bearer ?? (this.opts.allowQueryToken ? fromQuery : null);
    if (!raw) return this.fail(req, null, "missing");
    const m = TOKEN_PATTERN.exec(raw);
    if (!m) return this.fail(req, null, "malformed");
    const [, id, secret] = m as unknown as [string, string, string];
    const row = this.db.prepare(`SELECT * FROM ingest_tokens WHERE token_id = ?`).get(id) as TokenRow | undefined;
    // Hash even when the id is unknown, so timing does not reveal which ids exist.
    const given = sha256(secret);
    const matches = digestsEqual(given, row?.secret_sha256 ?? sha256(""));
    if (!row) return this.fail(req, id, "unknown");
    if (!matches) return this.fail(req, id, "wrong_secret");
    if (row.revoked_at !== null) return this.fail(req, id, "revoked");
    this.db.prepare(`UPDATE ingest_tokens SET last_used_at = ? WHERE token_id = ?`).run(now, id);
    const lanes = (JSON.parse(row.allowed_lanes) as unknown[]).filter(isSafeId);
    return this.done(req, id, { ok: true, storeId: row.store_id, allowedLanes: lanes, tokenId: id });
  }

  /** The lane a client asked for, if this result allows it (checked after authentication). */
  static laneFor(result: Extract<AuthResult, { ok: true }>, query: URLSearchParams): string | null {
    const lane = result.laneId ?? query.get("lane");
    return lane && isSafeId(lane) && result.allowedLanes.includes(lane) ? lane : null;
  }

  private fail(req: IngestRequest, tokenId: string | null, reason: AuthFailure): AuthResult {
    const list = this.failures.get(req.ip) ?? [];
    list.push(this.now());
    this.failures.set(req.ip, list);
    return this.done(req, tokenId, { ok: false, status: 401, reason });
  }

  private done(req: IngestRequest, tokenId: string | null, result: AuthResult, record = true): AuthResult {
    const line = { at: this.now(), ip: req.ip, token_id: tokenId, result: result.ok ? "ok" : String(result.status), reason: result.ok ? null : result.reason };
    if (record) this.db.prepare(`INSERT INTO ingest_auth_log (at, ip, token_id, result, reason) VALUES (?, ?, ?, ?, ?)`).run(line.at, line.ip, line.token_id, line.result, line.reason);
    this.opts.log?.({ event: "ingest_auth", ...line });
    return result;
  }
}
