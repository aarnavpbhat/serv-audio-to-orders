"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "./Badge";
import { JsonView } from "./JsonView";

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

  const load = useCallback(async () => {
    const res = await fetch("/api/mock-webhook", { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { settings: Settings; inbox: InboxRow[] };
    setSettings(json.settings);
    setInbox(json.inbox);
  }, []);

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
      <section className="panel space-y-3 p-4">
        <h2 className="text-[15px] font-bold">Failure Mode</h2>
        <div className="rounded-lg bg-fill px-3 py-2">
          Now: <span className="font-semibold">{MODES.find((m) => m.value === settings?.mode)?.label ?? "..."}</span>
          {settings && settings.mode !== "ok" && <span className="text-muted"> · {settings.remaining < 0 ? "every request" : `next ${settings.remaining} request(s)`}</span>}
        </div>
        <div className="space-y-1">
          {MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-fill">
              <input type="radio" name="mode" className="mt-0.5 accent-[var(--c-accent)]" checked={draft.mode === m.value} onChange={() => setDraft({ ...draft, mode: m.value })} />
              <span>
                {m.label}
                <span className="block text-[11.5px] text-muted">{m.help}</span>
              </span>
            </label>
          ))}
        </div>
        {draft.mode !== "ok" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="label">Fail next N</span>
              <input type="number" min={-1} value={draft.remaining} onChange={(e) => setDraft({ ...draft, remaining: Number(e.target.value) })} className="field mt-1" />
              <span className="text-[10.5px] text-muted">-1 = always</span>
            </label>
            {draft.mode === "rate_limit_429" && (
              <label className="text-xs">
                <span className="label">Retry-After (s)</span>
                <input type="number" min={0} value={draft.retry_after_s} onChange={(e) => setDraft({ ...draft, retry_after_s: Number(e.target.value) })} className="field mt-1" />
              </label>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" className="btn-accent" onClick={() => void apply(draft)}>
            Apply
          </button>
          <button type="button" className="btn" onClick={() => void apply({ mode: "ok", remaining: 0, retry_after_s: 3 })}>
            Reset to 200
          </button>
        </div>
      </section>

      <section className="min-w-0">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="section-title">Inbox</h2>
          <div className="flex items-center gap-3 text-[12px] text-muted">
            <span>
              {inbox.length} requests · {accepted} accepted
            </span>
            <button type="button" className="btn" onClick={() => void fetch("/api/mock-webhook", { method: "DELETE" }).then(load)}>
              Clear
            </button>
          </div>
        </div>
        {!inbox.length && <p className="py-3 text-muted">Nothing received yet. Start a run with delivery enabled.</p>}
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
                  <span className="font-mono text-xs text-muted">{new Date(r.received_at).toLocaleTimeString()}</span>
                  <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${r.status_returned < 300 ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" : "bg-rose-500/12 text-rose-700 dark:text-rose-400"}`}>{r.status_returned}</span>
                  <span className="font-mono text-xs">{r.webhook_id}</span>
                  <span className="text-xs text-muted">attempt {r.attempt ?? "?"}</span>
                  {r.signature_ok ? <span className="text-xs text-emerald-600 dark:text-emerald-400">signature ok</span> : <span className="text-xs text-rose-600 dark:text-rose-400">signature {r.verify_reason}</span>}
                  {r.duplicate === 1 && <Badge value="pending" label="duplicate (deduped)" />}
                  {r.mode !== "ok" && <span className="text-xs text-muted">simulated {r.mode}</span>}
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
