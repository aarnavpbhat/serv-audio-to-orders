/** Rows 27 and 28 against a throwaway local receiver (same logic as the Next.js mock route). */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OrderPayload } from "../schemas";
import { listMockInbox, openDb, setMockSettings } from "../store/db";
import { Deliverer } from "../webhook/deliver";
import { handleMockWebhook } from "../webhook/mock-receiver";
import { generateSecret } from "../webhook/signing";

export interface WebhookCheck {
  row: number;
  pass: boolean;
  detail: string;
}

export async function webhookSelfCheck(sample: OrderPayload): Promise<WebhookCheck[]> {
  const db = openDb(":memory:");
  const secret = generateSecret();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", async () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const out = await handleMockWebhook(db, secret, { headers, body });
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers }).end(JSON.stringify(out.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const deliverer = new Deliverer(db, {
    url,
    secret,
    timeoutMs: 5000,
    fastScheduleS: [1, 2, 4, 8, 16, 32],
    slowScheduleS: [300],
    userAgent: "serv-audio-orders/0.1",
  });
  const out: WebhookCheck[] = [];
  try {
    setMockSettings(db, { mode: "fail_500", remaining: 1, retry_after_s: 0 });
    const id27 = deliverer.enqueue({ ...sample, order_id: `${sample.order_id}_row27` }, null);
    const r27 = await deliverer.deliver(id27);
    const codes27 = deliverer.attempts(id27).map((a) => a.status_code);
    const accepted27 = listMockInbox(db).filter((r) => r.webhook_id === id27 && r.status_returned === 200 && r.duplicate === 0).length;
    out.push({ row: 27, pass: r27.status === "delivered" && codes27.join() === "500,200" && accepted27 === 1, detail: `attempts ${codes27.join(" -> ")}, ${accepted27} recorded` });

    setMockSettings(db, { mode: "rate_limit_429", remaining: 1, retry_after_s: 2 });
    const id28 = deliverer.enqueue({ ...sample, order_id: `${sample.order_id}_row28` }, null);
    const r28 = await deliverer.deliver(id28);
    const [a, b] = deliverer.attempts(id28);
    const waited = ((b?.started_at ?? 0) - (a?.started_at ?? 0)) / 1000;
    out.push({ row: 28, pass: r28.status === "delivered" && a?.status_code === 429 && waited >= 2, detail: `429 then ${b?.status_code}; waited ${waited.toFixed(1)}s for Retry-After 2` });
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
  return out;
}
