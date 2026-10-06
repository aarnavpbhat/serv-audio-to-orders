import { SectionHeader } from "@/components/SectionHeader";
import { Artwork } from "@/components/Artwork";
import { Badge } from "@/components/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { Progress } from "@/components/ui/Progress";
import { CheckIcon, XIcon } from "@/components/Icons";
import { readEvalReport, readHeldoutReport } from "@/lib/data";

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
  const held = readHeldoutReport();
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

      <section>
        <SectionHeader title="Layer A: Heard" details="Orders against what was said (hand-checked expected orders)" />
        <Metrics metrics={metrics} />
      </section>

      {r.layer_b && (
        <section>
          <SectionHeader title="Layer B: Rung Up" details={<>Orders against POS tickets ({r.layer_b.source} until Serv shares real ones), matched within ±{r.layer_b.window_s} s</>} />
          <Metrics
            metrics={[
              ["Exact ticket match", `${r.layer_b.exact}/${r.layer_b.tickets}`, r.layer_b.exact_rate],
              ["Extraction errors", String(r.layer_b.extraction_error), null],
              ["Window changes", String(r.layer_b.window_change), null],
              ["Unmatched", String(r.layer_b.unmatched), null],
            ]}
          />
        </section>
      )}

      {r.live && (
        <section>
          <SectionHeader title="Live Path" details="Conversation end to order sent, estimated at max speed (tracker lag on recording time plus processing)" />
          <Metrics
            metrics={[
              ["Close latency p50", `${(r.live.close_latency_p50_ms / 1000).toFixed(1)} s`, null],
              ["Close latency p95", `${(r.live.close_latency_p95_ms / 1000).toFixed(1)} s`, null],
              ["Reopens", `${pct(r.live.reopen_rate)} · ${r.live.premature_reopens} premature`, null],
              ["Duplicate versions", String(r.live.duplicate_versions), null],
            ]}
          />
          <div className="tracks mt-3 text-[13px]">
            {Object.entries(r.live.close_latency_by_trigger).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[minmax(0,1fr)_90px_110px_110px] gap-3 px-2 py-1.5">
                <span className="capitalize">Closed by {k.replace(/_/g, " ")}</span>
                <span className="text-right tabular-nums text-muted-foreground">{v.orders} orders</span>
                <span className="text-right tabular-nums">p50 {(v.p50_ms / 1000).toFixed(1)} s</span>
                <span className="text-right tabular-nums">p95 {(v.p95_ms / 1000).toFixed(1)} s</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeader title="Held-Out Set" details="Real voices, expected orders checked by hand, never used for tuning" />
        {held ? (
          <>
            <p className="mb-2 text-[12px] text-muted-foreground">
              {held.config.transcriber} + {held.config.extractor} · {new Date(held.generated_at).toLocaleString()} · {held.usage.deepgram_minutes} Deepgram min
            </p>
            <Metrics
              metrics={[
                ["Recordings passed", `${held.summary.passed}/${held.summary.fixtures}`, held.summary.fixtures ? held.summary.passed / held.summary.fixtures : null],
                ["Item precision", pct(held.summary.item_precision), held.summary.item_precision],
                ["Item recall", pct(held.summary.item_recall), held.summary.item_recall],
                ["Status accuracy", pct(held.summary.status_accuracy), held.summary.status_accuracy],
              ]}
            />
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Not run yet. Record conversations in the simulator (tick &ldquo;held out&rdquo;) or import phone recordings with <code className="font-mono">pnpm pipeline heldout import</code>, write their expected orders, then run{" "}
            <code className="font-mono">pnpm pipeline heldout eval --transcriber deepgram --yes</code>.
          </p>
        )}
      </section>

      <div className="grid items-start gap-10 xl:grid-cols-2">
        <section>
          <SectionHeader title="Edge Case Checklist" details={<>{r.rows.filter((x) => x.pass).length}/{r.rows.length} pass</>} />
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
          <SectionHeader title="Fixtures" details="Click to open the run" />
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

function Metrics({ metrics }: { metrics: [string, string, number | null][] }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {metrics.map(([k, v, ratio]) => (
        <Card key={k} size="sm">
          <CardContent>
            <div className="label text-[10.5px]">{k}</div>
            <div className="mt-1 font-heading text-[26px] font-bold tabular-nums tracking-tight">{v}</div>
            {ratio !== null && <Progress value={Math.min(1, ratio) * 100} className="mt-2 h-1" />}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
