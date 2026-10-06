"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/RadioGroup";
import { cn } from "@/lib/utils";
import { Badge } from "./Badge";
import { JsonView } from "./JsonView";
import { SectionHeader } from "@/components/SectionHeader";

interface Settings {
  mode: "ok" | "fail_500" | "rate_limit_429" | "timeout";
  remaining: number;
  retry_after_s: number;
}

interface InboxRow {
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

interface KeptOrder {
  order_id: string;
  order_version: number;
  webhook_id: string;
  status: string | null;
  received_at: number;
}

const MODES: { value: Settings["mode"]; label: string; help: string }[] = [
  { value: "ok", label: "Accept (200)", help: "Normal operation" },
  { value: "fail_500", label: "Fail with 500", help: "Row 27: sender retries with backoff" },
  { value: "rate_limit_429", label: "Rate limit (429)", help: "Row 28: sender waits for Retry-After" },
  { value: "timeout", label: "Time out", help: "Hangs 15s; sender aborts at 10s and retries" },
];

export function MockInbox() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings>({ mode: "fail_500", remaining: 1, retry_after_s: 3 });
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [kept, setKept] = useState<KeptOrder[]>([]);

  // State is set in the promise callback, never synchronously inside the polling effect.
  const load = useCallback(
    () =>
      fetch("/api/mock-webhook", { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ settings: Settings; inbox: InboxRow[]; orders: KeptOrder[] }>) : null))
        .then((json) => {
          if (!json) return;
          setSettings(json.settings);
          setInbox(json.inbox);
          setKept(json.orders);
        }),
    [],
  );

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  async function apply(s: Settings) {
    await fetch("/api/mock-webhook/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) });
    void load();
  }

  const accepted = inbox.filter((r) => r.status_returned === 200 && !r.duplicate).length;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[300px_1fr]">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-[15px] font-bold">Failure Mode</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg bg-muted px-3 py-2">
            Now: <span className="font-semibold">{MODES.find((m) => m.value === settings?.mode)?.label ?? "..."}</span>
            {settings && settings.mode !== "ok" && <span className="text-muted-foreground"> · {settings.remaining < 0 ? "every request" : `next ${settings.remaining} request(s)`}</span>}
          </div>
          <RadioGroup value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v as Settings["mode"] })} className="gap-1">
            {MODES.map((m) => (
              <Label key={m.value} htmlFor={`mode-${m.value}`} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-[13px] font-normal hover:bg-muted">
                <RadioGroupItem id={`mode-${m.value}`} value={m.value} className="mt-0.5" />
                <span>
                  {m.label}
                  <span className="block text-[11.5px] text-muted-foreground">{m.help}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          {draft.mode !== "ok" && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="fail-next" className="label">
                  Fail next N
                </Label>
                <Input id="fail-next" type="number" min={-1} value={draft.remaining} onChange={(e) => setDraft({ ...draft, remaining: Number(e.target.value) })} className="h-7 md:text-[13px]" />
                <span className="text-[10.5px] text-muted-foreground">-1 = always</span>
              </div>
              {draft.mode === "rate_limit_429" && (
                <div className="space-y-1">
                  <Label htmlFor="retry-after" className="label">
                    Retry-After (s)
                  </Label>
                  <Input id="retry-after" type="number" min={0} value={draft.retry_after_s} onChange={(e) => setDraft({ ...draft, retry_after_s: Number(e.target.value) })} className="h-7 md:text-[13px]" />
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" className="font-semibold" onClick={() => void apply(draft)}>
              Apply
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void apply({ mode: "ok", remaining: 0, retry_after_s: 3 })}>
              Reset to 200
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="min-w-0">
        {kept.length > 0 && (
          <div className="mb-6">
            <SectionHeader title="Kept Orders" details="The highest version received per order_id, as a receiver should keep it." />
            <div className="tracks">
              {kept.map((o) => (
                <div key={o.order_id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <span className="font-mono text-xs">{o.order_id}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">v{o.order_version}</span>
                  {o.status && <Badge value={o.status} />}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{new Date(o.received_at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <SectionHeader
          title="Inbox"
          details={`${inbox.length} requests · ${accepted} accepted`}
          actions={
            <Button size="sm" variant="secondary" onClick={() => void fetch("/api/mock-webhook", { method: "DELETE" }).then(load)}>
              Clear
            </Button>
          }
        />
        {!inbox.length && <p className="py-3 text-muted-foreground">Nothing received yet. Start a run with delivery enabled.</p>}
        <div className="tracks">
          {inbox.map((r) => {
            const body = (() => {
              try {
                return JSON.parse(r.body) as { order_id?: string; status?: string; items?: unknown[] };
              } catch {
                return null;
              }
            })();
            return (
              <div key={r.id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{new Date(r.received_at).toLocaleTimeString()}</span>
                  <span className={cn("rounded px-1.5 py-0.5 font-mono text-xs", r.status_returned < 300 ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" : "bg-destructive/12 text-destructive")}>{r.status_returned}</span>
                  <span className="font-mono text-xs">{r.webhook_id}</span>
                  <span className="text-xs text-muted-foreground">attempt {r.attempt ?? "?"}</span>
                  {r.signature_ok ? <span className="text-xs text-emerald-600 dark:text-emerald-400">signature ok</span> : <span className="text-xs text-rose-600 dark:text-rose-400">signature {r.verify_reason}</span>}
                  {r.duplicate === 1 && <Badge value="pending" label="duplicate (deduped)" />}
                  {r.mode !== "ok" && <span className="text-xs text-muted-foreground">simulated {r.mode}</span>}
                  {body?.status && <Badge value={body.status} />}
                </div>
                <div className="mt-1 flex gap-4">
                  <JsonView value={JSON.parse(r.headers)} summary="Headers" />
                  <JsonView value={body ?? r.body} summary="Body" />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
