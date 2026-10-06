"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/lib/utils";
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

/** Zebra rows with rounded ends, like an Apple Music song list. */
const ROW = "group cursor-pointer border-0 odd:bg-stripe hover:bg-muted [&>td:first-child]:rounded-l-md [&>td:last-child]:rounded-r-md";

export function RunsTable({ query }: { query: string }) {
  const router = useRouter();
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
        {shown && <span className="text-[12px] text-muted-foreground">{shown.length} runs{q && ` matching "${query}"`}</span>}
      </div>
      {!shown && <p className="py-6 text-muted-foreground">Loading runs...</p>}
      {shown?.length === 0 && (
        <p className="py-6 text-muted-foreground">
          {q ? "No runs match." : <>No runs yet. Start one above, or run <code className="font-mono">pnpm pipeline run &lt;file.mp3&gt;</code>.</>}
        </p>
      )}
      {shown && shown.length > 0 && (
        <Table className="table-fixed text-[13px]">
          <TableHeader className="[&_tr]:border-line">
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-7 w-10 text-center text-[11px] text-muted-foreground">#</TableHead>
              <TableHead className="h-7 w-[32%] text-[11px] text-muted-foreground">Title</TableHead>
              <TableHead className="h-7 w-[13%] text-[11px] text-muted-foreground">Status</TableHead>
              <TableHead className="h-7 w-16 text-right text-[11px] text-muted-foreground">Orders</TableHead>
              <TableHead className="h-7 text-[11px] text-muted-foreground">Webhooks</TableHead>
              <TableHead className="h-7 text-[11px] text-muted-foreground">Providers</TableHead>
              <TableHead className="h-7 w-20 text-[11px] text-muted-foreground">Started</TableHead>
              <TableHead className="h-7 w-14 text-[11px] text-muted-foreground">
                <ClockIcon className="ml-auto size-3.5" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="before:block before:h-1">
            {shown.map((r, i) => {
              const busy = r.status === "running" || r.status === "queued";
              return (
                <TableRow key={r.id} className={ROW} onClick={() => router.push(`/runs/${r.id}`)}>
                  <TableCell className="py-1.5 text-center text-[12px] tabular-nums text-muted-foreground">
                    {busy ? (
                      <Equalizer className="mx-auto text-brand" />
                    ) : (
                      <>
                        <span className="group-hover:hidden">{i + 1}</span>
                        <PlayIcon className="mx-auto hidden size-3.5 text-foreground group-hover:block" />
                      </>
                    )}
                  </TableCell>
                  <TableCell className="py-1.5">
                    <Link href={`/runs/${r.id}`} className="flex min-w-0 items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
                      <Artwork seed={r.source_file} size="sm" className="!h-9 !w-9" />
                      <span className="min-w-0">
                        <span className={cn("block truncate font-medium", busy && "text-brand")}>{r.source_file.replace(/\.mp3$/, "")}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{r.id}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="py-1.5">
                    <Badge value={r.status} label={r.status === "running" ? `${r.stage}...` : undefined} />
                    {r.error && (
                      <span className="mt-0.5 block truncate text-[11px] text-destructive" title={r.error}>
                        {r.error}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{r.order_count}</TableCell>
                  <TableCell className="truncate py-1.5 text-muted-foreground">
                    {r.delivered} sent{r.undelivered > 0 && <span className="text-destructive"> · {r.undelivered} pending</span>}
                  </TableCell>
                  <TableCell className="truncate py-1.5 text-muted-foreground">
                    {r.transcriber ?? "-"} · {r.extractor ?? "-"}
                  </TableCell>
                  <TableCell className="py-1.5 text-muted-foreground">{when(r.created_at)}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-muted-foreground">{dur(r.duration_s)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
