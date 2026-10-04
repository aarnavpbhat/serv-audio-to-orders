import { Badge } from "@/components/Badge";
import { readEvalReport } from "@/lib/data";

export const dynamic = "force-dynamic";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function EvalPage() {
  const r = readEvalReport();
  if (!r) {
    return (
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Eval</h1>
        <p className="mt-2 text-sm text-muted">
          No report yet. Run <code className="font-mono">pnpm eval</code> (or <code className="font-mono">pnpm eval --transcriber script</code> without a Deepgram key) and refresh.
        </p>
      </div>
    );
  }
  const s = r.summary;
  const metrics = [
    ["Fixtures passed", `${s.fixtures_passed}/${s.fixtures}`],
    ["Item precision", pct(s.item_precision)],
    ["Item recall", pct(s.item_recall)],
    ["Bucket accuracy", pct(s.bucket_accuracy)],
    ["Status accuracy", pct(s.status_accuracy)],
    ["Flags exact", pct(s.flags_accuracy)],
    ["Segments", `${s.segmentation.found}/${s.segmentation.expected}`],
    ["Boundary error", `${s.segmentation.mean_start_err_s}s / ${s.segmentation.mean_end_err_s}s`],
  ];
  return (
    <div className="space-y-4">
      <section>
        <h1 className="text-xl font-semibold">Eval</h1>
        <p className="mt-1 text-sm text-muted">
          {r.config.transcriber} + {r.config.extractor} on {r.config.layout} fixtures · {new Date(r.generated_at).toLocaleString()} · {r.usage.deepgram_minutes} Deepgram min ·{" "}
          {r.usage.llm_calls} LLM calls ({r.usage.llm_cached_calls} cached)
        </p>
      </section>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {metrics.map(([k, v]) => (
          <div key={k} className="card p-3">
            <div className="label">{k}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </section>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Edge case checklist</h2>
          <table className="w-full text-sm">
            <tbody>
              {r.rows.map((row) => (
                <tr key={row.row} className="border-b border-line last:border-0">
                  <td className="w-10 px-4 py-1.5 text-right font-mono text-xs text-muted">{row.row}</td>
                  <td className="px-2 py-1.5">
                    {row.title}
                    <div className="text-[11px] text-muted">{row.detail ?? row.fixtures.join(", ")}</div>
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <Badge value={row.pass ? "pass" : "fail"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Fixtures</h2>
          <div className="divide-y divide-line">
            {r.fixtures.map((f) => {
              const diffs = f.error ? [f.error] : f.orders.comparisons.flatMap((c) => c.diffs);
              return (
                <div key={f.id} className="px-4 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge value={f.pass ? "pass" : "fail"} />
                    {f.run_id ? (
                      <a href={`/runs/${f.run_id}`} className="font-medium hover:underline">
                        {f.id}
                      </a>
                    ) : (
                      <span className="font-medium">{f.id}</span>
                    )}
                    <span className="text-xs text-muted">{f.title}</span>
                    <span className="ml-auto text-xs text-muted">
                      {f.segmentation.found}/{f.segmentation.expected} seg · {f.orders.produced}/{f.orders.expected} orders
                    </span>
                  </div>
                  {diffs.length > 0 && (
                    <ul className="mt-1 list-disc pl-6 font-mono text-[11px] text-rose-700">
                      {diffs.slice(0, 8).map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
