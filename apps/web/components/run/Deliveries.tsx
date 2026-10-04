"use client";

import { useState } from "react";
import type { DeliveryView, OrderView } from "@/lib/data";
import { Badge } from "../Badge";
import { JsonView } from "../JsonView";

export function Deliveries({ orders, onChange }: { orders: OrderView[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const rows = orders.flatMap((o) => o.deliveries.map((d) => ({ order: o, d })));

  async function resend(d: DeliveryView) {
    setBusy(d.webhook_id);
    await fetch(`/api/deliveries/${d.webhook_id}/resend`, { method: "POST" });
    setBusy(null);
    onChange();
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-semibold">Webhook deliveries</h2>
        <span className="text-xs text-muted">Standard Webhooks signing · retries 1, 2, 4, 8, 16, 32s then 5m to 10h · dead letter after 13 attempts</span>
      </div>
      {!rows.length && <p className="p-4 text-sm text-muted">No deliveries for this run (delivery disabled, or no orders yet).</p>}
      <div className="divide-y divide-line">
        {rows.map(({ order, d }) => (
          <div key={d.webhook_id} className="p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs">{d.webhook_id}</span>
              <Badge value={d.status} />
              <span className="text-xs text-muted">{order.payload.event_type}</span>
              <span className="text-xs text-muted">
                {d.attempt_count} attempt{d.attempt_count === 1 ? "" : "s"}
                {d.next_attempt_at && d.status === "pending" && ` · next retry ${new Date(d.next_attempt_at).toLocaleTimeString()}`}
              </span>
              <span className="truncate text-xs text-muted">{d.url}</span>
              {(d.status === "failed" || d.status === "dead" || d.status === "delivered") && (
                <button type="button" className="btn ml-auto" disabled={busy === d.webhook_id} onClick={() => void resend(d)}>
                  {busy === d.webhook_id ? "Sending..." : "Resend"}
                </button>
              )}
            </div>
            {d.attempts.length > 0 && (
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 font-medium">#</th>
                    <th className="py-1 font-medium">Time</th>
                    <th className="py-1 font-medium">Phase</th>
                    <th className="py-1 font-medium">Status</th>
                    <th className="py-1 font-medium">Latency</th>
                    <th className="py-1 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {d.attempts.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="py-1">{a.attempt}</td>
                      <td className="py-1">{new Date(a.started_at).toLocaleTimeString()}</td>
                      <td className="py-1">{a.phase}</td>
                      <td className={`py-1 ${a.status_code && a.status_code < 300 ? "text-emerald-700" : "text-rose-700"}`}>{a.status_code ?? "-"}</td>
                      <td className="py-1">{a.latency_ms ?? "-"} ms</td>
                      <td className="max-w-md truncate py-1 text-muted" title={a.error ?? a.response_body ?? ""}>
                        {a.error ?? a.response_body}
                        {a.retry_after_s !== null && ` · Retry-After ${a.retry_after_s}s`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-2">
              <JsonView value={order.payload} summary="Payload" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
