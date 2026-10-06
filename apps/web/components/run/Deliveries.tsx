"use client";

import { useState } from "react";
import type { DeliveryView, OrderView } from "@/lib/data";
import { Button } from "@/components/ui/Button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/lib/utils";
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
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="section-title">Webhook Deliveries</h2>
        <span className="text-[11.5px] text-muted-foreground">Standard Webhooks signing · retries 1, 2, 4, 8, 16, 32s then 5m to 10h · dead letter after 13 attempts</span>
      </div>
      {!rows.length && <p className="py-3 text-muted-foreground">No deliveries for this run (delivery disabled, or no orders yet).</p>}
      <div className="tracks">
        {rows.map(({ order, d }) => (
          <div key={d.webhook_id} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <Badge value={d.status} />
              <span className="font-mono text-[12px]">{d.webhook_id}</span>
              <span className="text-[12px] text-muted-foreground">{order.payload.event_type}</span>
              <span className="text-[12px] text-muted-foreground">
                {d.attempt_count} attempt{d.attempt_count === 1 ? "" : "s"}
                {d.next_attempt_at && d.status === "pending" && ` · next retry ${new Date(d.next_attempt_at).toLocaleTimeString()}`}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{d.url}</span>
              {(d.status === "failed" || d.status === "dead" || d.status === "delivered") && (
                <Button size="xs" variant="secondary" disabled={busy === d.webhook_id} onClick={() => void resend(d)}>
                  {busy === d.webhook_id ? "Sending..." : "Resend"}
                </Button>
              )}
            </div>
            {d.attempts.length > 0 && (
              <Table className="mt-2 text-[11.5px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {["#", "Time", "Phase", "Status", "Latency", "Detail"].map((h) => (
                      <TableHead key={h} className="h-6 px-0 pr-3 font-medium text-muted-foreground">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody className="font-mono">
                  {d.attempts.map((a) => (
                    <TableRow key={a.id} className="hover:bg-transparent">
                      <TableCell className="px-0 py-1 pr-3">{a.attempt}</TableCell>
                      <TableCell className="px-0 py-1 pr-3">{new Date(a.started_at).toLocaleTimeString()}</TableCell>
                      <TableCell className="px-0 py-1 pr-3">{a.phase}</TableCell>
                      <TableCell className={cn("px-0 py-1 pr-3", a.status_code && a.status_code < 300 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>{a.status_code ?? "-"}</TableCell>
                      <TableCell className="px-0 py-1 pr-3">{a.latency_ms ?? "-"} ms</TableCell>
                      <TableCell className="max-w-md truncate px-0 py-1 text-muted-foreground" title={a.error ?? a.response_body ?? ""}>
                        {a.error ?? a.response_body}
                        {a.retry_after_s !== null && ` · Retry-After ${a.retry_after_s}s`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="mt-1.5">
              <JsonView value={order.payload} summary="Payload" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
