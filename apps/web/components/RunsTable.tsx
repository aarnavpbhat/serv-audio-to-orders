"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "./Badge";

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

export function RunsTable() {
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

  if (!runs) return <div className="card p-6 text-sm text-muted">Loading runs...</div>;
  if (!runs.length) return <div className="card p-6 text-sm text-muted">No runs yet. Start one above, or run <code className="font-mono">pnpm pipeline run &lt;file.mp3&gt;</code>.</div>;

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-slate-50 text-left">
          <tr>
            <th className="label px-4 py-2">File</th>
            <th className="label px-4 py-2">Status</th>
            <th className="label px-4 py-2">Orders</th>
            <th className="label px-4 py-2">Webhooks</th>
            <th className="label px-4 py-2">Providers</th>
            <th className="label px-4 py-2">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-0 hover:bg-slate-50">
              <td className="px-4 py-2">
                <Link href={`/runs/${r.id}`} className="font-medium hover:underline">
                  {r.source_file}
                </Link>
                {r.duration_s !== null && <span className="ml-2 text-xs text-muted">{r.duration_s.toFixed(0)}s</span>}
              </td>
              <td className="px-4 py-2">
                <Badge value={r.status} label={r.status === "running" ? `${r.stage}...` : r.status} />
                {r.error && <div className="mt-1 max-w-xs truncate text-xs text-rose-700" title={r.error}>{r.error}</div>}
              </td>
              <td className="px-4 py-2 tabular-nums">{r.order_count}</td>
              <td className="px-4 py-2 tabular-nums">
                {r.delivered} sent{r.undelivered > 0 && <span className="text-rose-700">, {r.undelivered} pending/failed</span>}
              </td>
              <td className="px-4 py-2 text-xs text-muted">
                {r.transcriber ?? "-"}
                <br />
                {r.extractor ?? "-"}
              </td>
              <td className="px-4 py-2 text-xs text-muted">{new Date(r.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
