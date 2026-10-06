/** Step 7 gate: checklist rows 27 (500 then 200) and 28 (429 with Retry-After), plus signing and dead letters. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getMockSettings, listMockInbox, openDb, setMockSettings, type DB } from "../store/db";
import { Deliverer, parseRetryAfter, type DeliveryConfig } from "../webhook/deliver";
import { handleMockWebhook } from "../webhook/mock-receiver";
import { generateSecret, sign, signedHeaders, verify } from "../webhook/signing";
import type { OrderPayload } from "../schemas";

const secret = generateSecret();
let db: DB;
let server: Server;
let url: string;
let forcedStatus: number | null = null;

function payload(orderId: string): OrderPayload {
  return {
    schema_version: "1.0",
    event_type: "order.completed",
    order_id: orderId,
    order_version: 1,
    group_id: null,
    location_id: "store_demo_001",
    lane_id: "lane_1",
    status: "completed",
    started_at: "2026-10-03T18:41:01.200Z",
    ended_at: "2026-10-03T18:42:24.880Z",
    timestamp_source: "env",
    audio: { source_file: "x.mp3", offset_start_s: 1, offset_end_s: 2 },
    items: [],
    needs_review: [],
    not_ordered: [],
    combo_opportunities: [],
    customer_declined_combo: false,
    flags: [],
    totals: { computed: 0, spoken_by_crew: null, currency: "USD" },
    overall_confidence: 1,
    transcript: [],
    processing: { stt: "test", extractor: "test", menu_version: "sandbox-1", pipeline_version: "0.1.0", latency_ms: 1 },
  };
}

const cfg = (): DeliveryConfig => ({
  url,
  secret,
  timeoutMs: 1500,
  fastScheduleS: [1, 2, 4, 8, 16, 32],
  slowScheduleS: [300, 1800, 7200, 18000, 36000, 36000],
  userAgent: "serv-audio-orders/0.1",
});

beforeAll(async () => {
  db = openDb(":memory:");
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", async () => {
      if (forcedStatus !== null) {
        res.writeHead(forcedStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: "forced" }));
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const out = await handleMockWebhook(db, secret, { headers, body }, { hangMs: 3000 });
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  forcedStatus = null;
  setMockSettings(db, { mode: "ok", remaining: 0, retry_after_s: 3 });
});

const accepted = (webhookId: string) => listMockInbox(db).filter((r) => r.webhook_id === webhookId && r.duplicate === 0 && r.status_returned === 200);

describe("Standard Webhooks signing", () => {
  it("round-trips and rejects tampering, old timestamps and wrong secrets", () => {
    const body = JSON.stringify({ a: 1 });
    const h = signedHeaders(secret, "ord_1_v1", body);
    expect(verify(secret, { ...h }, body)).toEqual({ ok: true, id: "ord_1_v1" });
    expect(verify(secret, { ...h }, body + " ").reason).toBe("bad_signature");
    expect(verify(generateSecret(), { ...h }, body).reason).toBe("bad_signature");
    expect(verify(secret, { ...h }, body, Date.now() + 6 * 60_000).reason).toBe("timestamp_too_old");
    expect(verify(secret, {}, body).reason).toBe("missing_headers");
  });

  it("matches the Standard Webhooks reference vector", () => {
    // From the standard-webhooks spec test suite.
    const s = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const sig = sign(s, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    expect(sig).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3);
    const now = Date.parse("2026-10-03T18:00:00Z");
    expect(parseRetryAfter("Sat, 03 Oct 2026 18:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("delivery", () => {
  it("row 27: 500 then 200 retries and records exactly one delivery", async () => {
    setMockSettings(db, { mode: "fail_500", remaining: 1, retry_after_s: 0 });
    const d = new Deliverer(db, cfg());
    const id = d.enqueue(payload("ord_row27"), null);
    const row = await d.deliver(id);
    expect(row.status).toBe("delivered");
    const attempts = d.attempts(id);
    expect(attempts.map((a) => a.status_code)).toEqual([500, 200]);
    expect(accepted(id)).toHaveLength(1);
    // Resending a delivered order is deduped by the receiver.
    await d.resend(id);
    expect(accepted(id)).toHaveLength(1);
    expect(listMockInbox(db).filter((r) => r.webhook_id === id && r.duplicate === 1)).toHaveLength(1);
  });

  it("row 28: 429 with Retry-After waits the stated time", async () => {
    setMockSettings(db, { mode: "rate_limit_429", remaining: 1, retry_after_s: 2 });
    const d = new Deliverer(db, cfg(), { rand: () => 0 });
    const id = d.enqueue(payload("ord_row28"), null);
    const row = await d.deliver(id);
    expect(row.status).toBe("delivered");
    const [first, second] = d.attempts(id);
    expect(first?.status_code).toBe(429);
    expect(first?.retry_after_s).toBe(2);
    expect((second?.started_at ?? 0) - (first?.started_at ?? 0)).toBeGreaterThanOrEqual(2000);
    expect(accepted(id)).toHaveLength(1);
    expect(getMockSettings(db).mode).toBe("ok");
  });

  it("timeouts are retried", async () => {
    setMockSettings(db, { mode: "timeout", remaining: 1, retry_after_s: 0 });
    const d = new Deliverer(db, cfg(), { rand: () => 0 });
    const id = d.enqueue(payload("ord_timeout"), null);
    const row = await d.deliver(id);
    expect(row.status).toBe("delivered");
    expect(d.attempts(id)[0]?.error).toMatch(/timeout/);
  });

  it("other 4xx are not retried and keep the response body", async () => {
    forcedStatus = 422;
    const d = new Deliverer(db, cfg());
    const id = d.enqueue(payload("ord_422"), null);
    const row = await d.deliver(id);
    expect(row.status).toBe("failed");
    expect(d.attempts(id)).toHaveLength(1);
    expect(row.last_error).toBe("HTTP 422");
  });

  it("bad signatures are rejected by the receiver with 401 (not retried)", async () => {
    const d = new Deliverer(db, { ...cfg(), secret: generateSecret() });
    const id = d.enqueue(payload("ord_badsig"), null);
    expect((await d.deliver(id)).status).toBe("failed");
    expect(listMockInbox(db).find((r) => r.webhook_id === id)?.verify_reason).toBe("bad_signature");
  });

  it("fast phase, then slow phase via the worker, then dead letter; resend recovers", async () => {
    forcedStatus = 503;
    let clock = Date.now();
    const sleeps: number[] = [];
    const d = new Deliverer(db, cfg(), { now: () => clock, sleep: async (ms) => void sleeps.push(ms), rand: () => 1 });
    const id = d.enqueue(payload("ord_dead"), null);
    let row = await d.deliver(id);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
    expect(row.status).toBe("pending");
    expect(row.next_attempt_at).toBe(clock + 300_000);
    for (const waitS of [300, 1800, 7200, 18000, 36000, 36000]) {
      clock += waitS * 1000;
      [row] = (await d.processDue()) as [typeof row];
    }
    expect(row.status).toBe("dead");
    expect(d.attempts(id)).toHaveLength(13);
    forcedStatus = null;
    clock = Date.now(); // the receiver checks timestamps against the real clock
    expect((await d.resend(id)).status).toBe("delivered");
    expect(d.attempts(id).at(-1)?.phase).toBe("manual");
  });
});
