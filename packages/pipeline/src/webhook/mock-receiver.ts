/**
 * The mock receiver's logic, shared by the Next.js route (/api/mock-webhook)
 * and the tests. Verifies the signature and timestamp, dedupes on webhook-id,
 * stores payloads, keeps the highest version per order_id (as Serv should),
 * and can be toggled to fail with 500, 429 or a timeout.
 */
import { sleep } from "../lib/retry";
import { getMockSettings, setMockSettings, type DB } from "../store/db";
import { verify } from "./signing";

export interface MockRequest {
  headers: Record<string, string | null | undefined>;
  body: string;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  json: Record<string, unknown>;
}

export interface MockOptions {
  /** How long the "timeout" mode hangs before answering. Longer than the sender's 10s timeout. */
  hangMs?: number;
  now?: () => number;
}

export async function handleMockWebhook(db: DB, secret: string, req: MockRequest, opts: MockOptions = {}): Promise<MockResponse> {
  const now = opts.now ?? Date.now;
  const v = verify(secret, req.headers, req.body, now());
  const settings = getMockSettings(db);
  const webhookId = req.headers["webhook-id"] ?? null;
  const record = (status: number, duplicate: boolean, mode: string) =>
    db
      .prepare(
        `INSERT INTO mock_inbox (received_at, webhook_id, attempt, signature_ok, verify_reason, duplicate, status_returned, mode, headers, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now(), webhookId, req.headers["x-delivery-attempt"] ?? null, v.ok ? 1 : 0, v.reason ?? null, duplicate ? 1 : 0, status, mode, JSON.stringify(req.headers), req.body);

  if (!v.ok) {
    record(401, false, settings.mode);
    return { status: 401, headers: {}, json: { error: "invalid signature", reason: v.reason } };
  }

  if (settings.mode !== "ok" && settings.remaining !== 0) {
    const remaining = settings.remaining > 0 ? settings.remaining - 1 : -1;
    setMockSettings(db, { ...settings, mode: remaining === 0 ? "ok" : settings.mode, remaining });
    if (settings.mode === "fail_500") {
      record(500, false, settings.mode);
      return { status: 500, headers: {}, json: { error: "simulated server error" } };
    }
    if (settings.mode === "rate_limit_429") {
      record(429, false, settings.mode);
      return { status: 429, headers: { "retry-after": String(settings.retry_after_s) }, json: { error: "simulated rate limit" } };
    }
    if (settings.mode === "timeout") {
      record(504, false, settings.mode);
      await sleep(opts.hangMs ?? 15_000);
      return { status: 504, headers: {}, json: { error: "simulated timeout" } };
    }
  }

  const seen = db
    .prepare(`SELECT 1 FROM mock_inbox WHERE webhook_id = ? AND duplicate = 0 AND status_returned BETWEEN 200 AND 299 LIMIT 1`)
    .get(webhookId);
  if (seen) {
    record(200, true, "ok");
    return { status: 200, headers: {}, json: { received: true, duplicate: true } };
  }
  record(200, false, "ok");
  const kept = keepHighestVersion(db, webhookId ?? "", req.body, now());
  return { status: 200, headers: {}, json: { received: true, ...(kept ? { kept_version: kept } : {}) } };
}

/** Store the payload unless a newer version of the same order is already held. Returns the version now kept. */
function keepHighestVersion(db: DB, webhookId: string, body: string, at: number): number | null {
  let p: { order_id?: unknown; order_version?: unknown; status?: unknown };
  try {
    p = JSON.parse(body) as typeof p;
  } catch {
    return null;
  }
  if (typeof p.order_id !== "string" || typeof p.order_version !== "number") return null;
  db.prepare(
    `INSERT INTO mock_orders (order_id, order_version, webhook_id, status, body, received_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET order_version = excluded.order_version, webhook_id = excluded.webhook_id, status = excluded.status, body = excluded.body, received_at = excluded.received_at
     WHERE excluded.order_version > mock_orders.order_version`,
  ).run(p.order_id, p.order_version, webhookId, typeof p.status === "string" ? p.status : null, body, at);
  const row = db.prepare(`SELECT order_version FROM mock_orders WHERE order_id = ?`).get(p.order_id) as { order_version: number } | undefined;
  return row?.order_version ?? null;
}
