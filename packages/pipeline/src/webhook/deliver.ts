/**
 * Webhook delivery with an SQLite outbox.
 *   1. finalize -> write outbox row -> send immediately (10s timeout, any 2xx = success)
 *   2. retry network errors, timeouts, 408, 429, 5xx; honor Retry-After; other 4xx = failed
 *   3. fast phase inline: ~1, 2, 4, 8, 16, 32s with full jitter (cars move in minutes)
 *   4. slow phase via the worker: 5m, 30m, 2h, 5h, 10h, 10h
 *   5. then dead letter (Resend in the UI, `pipeline resend <order_id>` in the CLI)
 * The body never changes between retries; webhook-id is constant so receivers can dedupe.
 */
import type { OrderPayload } from "../schemas";
import { sleep as realSleep } from "../lib/retry";
import { attemptsFor, getOutbox, type AttemptRow, type DB, type OutboxRow } from "../store/db";
import { webhookId as makeWebhookId } from "./payload";
import { signedHeaders } from "./signing";

export interface DeliveryConfig {
  url: string;
  secret: string;
  timeoutMs: number;
  fastScheduleS: number[];
  slowScheduleS: number[];
  userAgent: string;
}

export interface DelivererDeps {
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  now?: () => number;
  log?: (msg: string) => void;
}

interface AttemptOutcome {
  ok: boolean;
  retryable: boolean;
  statusCode: number | null;
  retryAfterS: number | null;
  error: string | null;
  body: string | null;
  latencyMs: number;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return s;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.max(0, (t - now) / 1000);
}

export const isRetryableStatus = (code: number) => code === 408 || code === 429 || code >= 500;

export class Deliverer {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly db: DB,
    private readonly cfg: DeliveryConfig,
    deps: DelivererDeps = {},
  ) {
    this.sleep = deps.sleep ?? realSleep;
    this.rand = deps.rand ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** Writes the outbox row (idempotent per order version) and returns the webhook id. */
  enqueue(payload: OrderPayload, runId: string | null): string {
    const id = makeWebhookId(payload.order_id, payload.order_version);
    const now = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (webhook_id, order_id, order_version, run_id, url, body, status, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(id, payload.order_id, payload.order_version, runId, this.cfg.url, JSON.stringify(payload), now, now);
    return id;
  }

  /** Send now and run the fast retry phase inline. Leaves the row delivered, failed, or scheduled for the slow phase. */
  async deliver(webhookId: string, phase: "fast" | "manual" = "fast"): Promise<OutboxRow> {
    if (!this.claim(webhookId, ["pending"])) return getOutbox(this.db, webhookId) as OutboxRow;
    for (;;) {
      const row = getOutbox(this.db, webhookId) as OutboxRow;
      const outcome = await this.attempt(row, phase);
      const n = row.attempt_count + 1;
      if (outcome.ok) return this.finish(webhookId, n, "delivered", outcome);
      if (!outcome.retryable) return this.finish(webhookId, n, "failed", outcome);
      if (n <= this.cfg.fastScheduleS.length) {
        const base = (this.cfg.fastScheduleS[n - 1] ?? 1) * 1000;
        const delay = outcome.retryAfterS !== null ? outcome.retryAfterS * 1000 : Math.round(this.rand() * base);
        this.setRow(webhookId, { attempt_count: n, last_status_code: outcome.statusCode, last_error: outcome.error });
        this.log(`${webhookId}: attempt ${n} ${outcome.statusCode ?? outcome.error}; retry in ${(delay / 1000).toFixed(1)}s`);
        await this.sleep(delay);
        continue;
      }
      return this.scheduleSlow(webhookId, n, outcome);
    }
  }

  /** Worker tick: one attempt for every row whose slow-phase time has come. */
  async processDue(): Promise<OutboxRow[]> {
    const due = this.db
      .prepare(`SELECT webhook_id FROM outbox WHERE status = 'pending' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`)
      .all(this.now()) as { webhook_id: string }[];
    const done: OutboxRow[] = [];
    for (const { webhook_id } of due) {
      if (!this.claim(webhook_id, ["pending"])) continue;
      const row = getOutbox(this.db, webhook_id) as OutboxRow;
      const outcome = await this.attempt(row, "slow");
      const n = row.attempt_count + 1;
      if (outcome.ok) done.push(this.finish(webhook_id, n, "delivered", outcome));
      else if (!outcome.retryable) done.push(this.finish(webhook_id, n, "failed", outcome));
      else done.push(this.scheduleSlow(webhook_id, n, outcome));
    }
    return done;
  }

  /** Manual resend of a failed or dead delivery: same body and webhook-id, fresh schedule. */
  async resend(webhookId: string): Promise<OutboxRow> {
    const row = getOutbox(this.db, webhookId);
    if (!row) throw new Error(`No delivery ${webhookId}`);
    if (row.status === "delivering") throw new Error(`${webhookId} is being delivered right now`);
    this.setRow(webhookId, { status: "pending", attempt_count: 0, next_attempt_at: null });
    return this.deliver(webhookId, "manual");
  }

  /** Rows left in 'delivering' by a crashed process go back to the queue. */
  recoverStuck(olderThanMs = 120_000): number {
    return this.db
      .prepare(`UPDATE outbox SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'delivering' AND updated_at < ?`)
      .run(this.now(), this.now(), this.now() - olderThanMs).changes;
  }

  attempts(webhookId: string): AttemptRow[] {
    return attemptsFor(this.db, webhookId);
  }

  // ------------------------------------------------------------ internals

  private claim(webhookId: string, from: OutboxRow["status"][]): boolean {
    const placeholders = from.map(() => "?").join(",");
    return (
      this.db
        .prepare(`UPDATE outbox SET status = 'delivering', next_attempt_at = NULL, updated_at = ? WHERE webhook_id = ? AND status IN (${placeholders})`)
        .run(this.now(), webhookId, ...from).changes === 1
    );
  }

  private setRow(webhookId: string, patch: Partial<OutboxRow>): void {
    const keys = Object.keys(patch);
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
    this.db.prepare(`UPDATE outbox SET ${sets} WHERE webhook_id = ?`).run(...keys.map((k) => patch[k as keyof OutboxRow] ?? null), this.now(), webhookId);
  }

  private finish(webhookId: string, n: number, status: "delivered" | "failed" | "dead", o: AttemptOutcome): OutboxRow {
    this.setRow(webhookId, {
      status,
      attempt_count: n,
      last_status_code: o.statusCode,
      last_error: status === "delivered" ? null : (o.error ?? o.body),
      next_attempt_at: null,
      ...(status === "delivered" ? { delivered_at: this.now() } : {}),
    });
    this.log(`${webhookId}: ${status} after ${n} attempt(s) (${o.statusCode ?? o.error})`);
    return getOutbox(this.db, webhookId) as OutboxRow;
  }

  private scheduleSlow(webhookId: string, n: number, o: AttemptOutcome): OutboxRow {
    const slowIndex = n - this.cfg.fastScheduleS.length - 1;
    const waitS = this.cfg.slowScheduleS[slowIndex];
    if (waitS === undefined) return this.finish(webhookId, n, "dead", o);
    const delayMs = Math.max(waitS, o.retryAfterS ?? 0) * 1000;
    this.setRow(webhookId, {
      status: "pending",
      attempt_count: n,
      next_attempt_at: this.now() + delayMs,
      last_status_code: o.statusCode,
      last_error: o.error ?? o.body,
    });
    this.log(`${webhookId}: attempt ${n} failed; slow retry in ${Math.round(delayMs / 1000)}s`);
    return getOutbox(this.db, webhookId) as OutboxRow;
  }

  private async attempt(row: OutboxRow, phase: "fast" | "slow" | "manual"): Promise<AttemptOutcome> {
    const attemptNo =
      ((this.db.prepare(`SELECT MAX(attempt) AS m FROM attempts WHERE webhook_id = ?`).get(row.webhook_id) as { m: number | null }).m ?? 0) + 1;
    const startedAt = this.now();
    const t0 = performance.now();
    let outcome: AttemptOutcome;
    try {
      const res = await fetch(row.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": this.cfg.userAgent,
          "x-delivery-attempt": String(attemptNo),
          ...signedHeaders(this.cfg.secret, row.webhook_id, row.body, this.now()),
        },
        body: row.body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      const text = (await res.text()).slice(0, 2000);
      outcome = {
        ok: res.ok,
        retryable: !res.ok && isRetryableStatus(res.status),
        statusCode: res.status,
        retryAfterS: res.ok ? null : parseRetryAfter(res.headers.get("retry-after"), this.now()),
        error: res.ok ? null : `HTTP ${res.status}`,
        body: text,
        latencyMs: Math.round(performance.now() - t0),
      };
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === "TimeoutError" || err.name === "AbortError";
      outcome = {
        ok: false,
        retryable: true,
        statusCode: null,
        retryAfterS: null,
        error: timeout ? `timeout after ${this.cfg.timeoutMs}ms` : `network: ${(err.cause as Error | undefined)?.message ?? err.message}`,
        body: null,
        latencyMs: Math.round(performance.now() - t0),
      };
    }
    this.db
      .prepare(
        `INSERT INTO attempts (webhook_id, attempt, phase, started_at, latency_ms, status_code, error, response_body, retry_after_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.webhook_id, attemptNo, phase, startedAt, outcome.latencyMs, outcome.statusCode, outcome.error, outcome.body, outcome.retryAfterS);
    return outcome;
  }
}
