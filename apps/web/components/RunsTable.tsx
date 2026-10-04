"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Artwork } from "./Artwork";
import { Badge } from "./Badge";
import { ClockIcon, Equalizer, PlayIcon } from "./Icons";

interface RunSummary {
  id: string;
  created_at: number;
  source_file: string;
  status: string;
  stage: string | null;
  error: string | null;
  transcriber: string | null;
  extractor: string | null;
  duration_s: number | null;
  order_count: number;
  delivered: number;
  undelivered: number;
}

const dur = (s: number | null) => (s === null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

function when(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function RunsTable({ query }: { query: string }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await fetch("/api/runs", { cache: "no-store" });
      if (alive && res.ok) setRuns((await res.json()) as RunSummary[]);
    };
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const q = query.toLowerCase();
  const shown = runs?.filter((r) => !q || `${r.source_file} ${r.status} ${r.transcriber} ${r.extractor} ${r.id}`.toLowerCase().includes(q));

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="section-title">Recent Runs</h2>
        {shown && <span className="text-[12px] text-muted">{shown.length} runs{q && ` matching "${query}"`}</span>}
      </div>
      {!shown && <p className="py-6 text-muted">Loading runs...</p>}
      {shown?.length === 0 && (
        <p className="py-6 text-muted">
          {q ? "No runs match." : <>No runs yet. Start one above, or run <code className="font-mono">pnpm pipeline run &lt;file.mp3&gt;</code>.</>}
        </p>
      )}
      {shown && shown.length > 0 && (
        <div className="text-[13px]">
          <div className="grid grid-cols-[32px_minmax(0,2.4fr)_minmax(0,1fr)_70px_minmax(0,1.3fr)_minmax(0,1.2fr)_70px_48px] items-center gap-3 border-b border-line px-2 pb-1.5 text-[11px] font-medium text-muted">
            <span className="text-center">#</span>
            <span>Title</span>
            <span>Status</span>
            <span className="text-right">Orders</span>
            <span>Webhooks</span>
            <span>Providers</span>
            <span>Started</span>
            <span className="flex justify-end">
              <ClockIcon className="h-3.5 w-3.5" />
            </span>
          </div>
          <div className="tracks mt-1">
            {shown.map((r, i) => {
              const busy = r.status === "running" || r.status === "queued";
              return (
                <Link key={r.id} href={`/runs/${r.id}`} className="group grid grid-cols-[32px_minmax(0,2.4fr)_minmax(0,1fr)_70px_minmax(0,1.3fr)_minmax(0,1.2fr)_70px_48px] items-center gap-3 px-2 py-1.5">
                  <span className="grid place-items-center text-[12px] tabular-nums text-muted">
                    {busy ? (
                      <Equalizer className="text-accent" />
                    ) : (
                      <>
                        <span className="group-hover:hidden">{i + 1}</span>
                        <PlayIcon className="hidden h-3.5 w-3.5 text-ink group-hover:block" />
                      </>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Artwork seed={r.source_file} size="sm" className="!h-9 !w-9" />
                    <span className="min-w-0">
                      <span className={`block truncate font-medium ${busy ? "text-accent" : ""}`}>{r.source_file.replace(/\.mp3$/, "")}</span>
                      <span className="block truncate font-mono text-[11px] text-muted">{r.id}</span>
                    </span>
                  </span>
                  <span className="min-w-0">
                    <Badge value={r.status} label={r.status === "running" ? `${r.stage}...` : undefined} />
                    {r.error && (
                      <span className="mt-0.5 block truncate text-[11px] text-rose-600 dark:text-rose-400" title={r.error}>
                        {r.error}
                      </span>
                    )}
                  </span>
                  <span className="text-right tabular-nums">{r.order_count}</span>
                  <span className="truncate text-muted">
                    {r.delivered} sent{r.undelivered > 0 && <span className="text-rose-600 dark:text-rose-400"> · {r.undelivered} pending</span>}
                  </span>
                  <span className="truncate text-muted">
                    {r.transcriber ?? "-"} · {r.extractor ?? "-"}
                  </span>
                  <span className="text-muted">{when(r.created_at)}</span>
                  <span className="text-right tabular-nums text-muted">{dur(r.duration_s)}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
