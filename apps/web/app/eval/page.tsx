import { Artwork } from "@/components/Artwork";
import { Badge } from "@/components/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { Progress } from "@/components/ui/Progress";
import { CheckIcon, XIcon } from "@/components/Icons";
import { readEvalReport } from "@/lib/data";

export const dynamic = "force-dynamic";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function EvalPage() {
  const r = readEvalReport();
  if (!r) {
    return (
      <div className="mx-auto max-w-[1180px] px-8 pt-8">
        <h1 className="title-xl">Eval</h1>
        <p className="mt-2 text-muted-foreground">
          No report yet. Run <code className="font-mono">pnpm eval</code> (or <code className="font-mono">pnpm eval --transcriber script</code> without a Deepgram key) and refresh.
        </p>
      </div>
    );
  }
  const s = r.summary;
  const metrics: [string, string, number | null][] = [
    ["Fixtures passed", `${s.fixtures_passed}/${s.fixtures}`, s.fixtures ? s.fixtures_passed / s.fixtures : null],
    ["Item precision", pct(s.item_precision), s.item_precision],
    ["Item recall", pct(s.item_recall), s.item_recall],
    ["Bucket accuracy", pct(s.bucket_accuracy), s.bucket_accuracy],
    ["Status accuracy", pct(s.status_accuracy), s.status_accuracy],
    ["Flags exact", pct(s.flags_accuracy), s.flags_accuracy],
    ["Segments", `${s.segmentation.found}/${s.segmentation.expected}`, s.segmentation.expected ? s.segmentation.found / s.segmentation.expected : null],
    ["Boundary error", `${s.segmentation.mean_start_err_s}s / ${s.segmentation.mean_end_err_s}s`, null],
  ];
  return (
    <div className="mx-auto max-w-[1180px] space-y-10 px-8 pb-16 pt-8">
      <header>
        <h1 className="title-xl">Eval</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {r.config.transcriber} + {r.config.extractor} on {r.config.layout} fixtures · {new Date(r.generated_at).toLocaleString()} · {r.usage.deepgram_minutes} Deepgram min · {r.usage.llm_calls} LLM calls (
          {r.usage.llm_cached_calls} cached)
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {metrics.map(([k, v, ratio]) => (
          <Card key={k} size="sm">
            <CardContent>
              <div className="label text-[10.5px]">{k}</div>
              <div className="mt-1 font-heading text-[26px] font-bold tabular-nums tracking-tight">{v}</div>
              {ratio !== null && <Progress value={Math.min(1, ratio) * 100} className="mt-2 h-1" />}
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid items-start gap-10 xl:grid-cols-2">
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="section-title">Edge Case Checklist</h2>
            <span className="text-[12px] text-muted-foreground">
              {r.rows.filter((x) => x.pass).length}/{r.rows.length} pass
            </span>
          </div>
          <div className="tracks">
            {r.rows.map((row) => (
              <div key={row.row} className="grid grid-cols-[32px_minmax(0,1fr)_20px] items-center gap-3 px-2 py-1.5">
                <span className="text-center text-[12px] tabular-nums text-muted-foreground">{row.row}</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{row.title}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">{row.detail ?? row.fixtures.join(", ")}</span>
                </span>
                {row.pass ? <CheckIcon className="h-4 w-4 text-emerald-500" /> : <XIcon className="h-4 w-4 text-rose-500" />}
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="section-title">Fixtures</h2>
            <span className="text-[12px] text-muted-foreground">click to open the run</span>
          </div>
          <div className="tracks">
            {r.fixtures.map((f) => {
              const diffs = f.error ? [f.error] : f.orders.comparisons.flatMap((c) => c.diffs);
              const row = (
                <>
                  <div className="flex items-center gap-3">
                    <Artwork seed={f.id} size="sm" className="!h-9 !w-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{f.title}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {f.id} · {f.segmentation.found}/{f.segmentation.expected} seg · {f.orders.produced}/{f.orders.expected} orders
                      </span>
                    </span>
                    <Badge value={f.pass ? "pass" : "fail"} />
                  </div>
                  {diffs.length > 0 && (
                    <ul className="mt-1 list-disc pl-[60px] font-mono text-[11px] text-destructive">
                      {diffs.slice(0, 8).map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </>
              );
              return f.run_id ? (
                <a key={f.id} href={`/runs/${f.run_id}`} className="block px-2 py-1.5">
                  {row}
                </a>
              ) : (
                <div key={f.id} className="px-2 py-1.5">
                  {row}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
