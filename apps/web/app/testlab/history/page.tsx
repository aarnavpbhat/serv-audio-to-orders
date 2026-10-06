import { getConfig } from "@serv/config";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/Badge";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { isLocalHeaders } from "@/lib/dev-routes";
import { history } from "@/lib/testlab";

export const dynamic = "force-dynamic";

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const secs = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const SELECT = "h-8 rounded-md border border-input bg-transparent px-2 text-[13px]";
const MODE_NAMES: Record<string, string> = { both: "Just me, both parts", robot: "Just me, robot crew", two: "Two people" };

/** Test Lab results over time: pass rate, transcript errors, roles and speed per scenario, by tester mode and model. */
export default async function TestLabHistory({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!getConfig().enableDevRoutes || !isLocalHeaders(await headers())) notFound();
  const q = await searchParams;
  const h = history({ ...(q.mode ? { testerMode: q.mode } : {}), ...(q.model ? { stt: q.model } : {}) });
  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-8 pb-16 pt-8">
      <header>
        <Link href="/testlab" className="text-[13px] text-brand hover:underline">
          Back to Test Lab
        </Link>
        <h1 className="title-xl mt-1">Test Lab results</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">How the system does on each scenario, across every run. Filter by who tested and by speech model.</p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 text-[13px]">
        <label className="space-y-1">
          <span className="label block text-[10.5px]">Tester mode</span>
          <select name="mode" defaultValue={q.mode ?? ""} className={SELECT} aria-label="Tester mode">
            <option value="">Any</option>
            {h.modes.map((m) => (
              <option key={m} value={m}>
                {MODE_NAMES[m] ?? m}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="label block text-[10.5px]">Speech model</span>
          <select name="model" defaultValue={q.model ?? ""} className={SELECT} aria-label="Speech model">
            <option value="">Any</option>
            {h.models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm">
          Filter
        </Button>
      </form>

      <section>
        <SectionHeader title="By scenario" details={`${h.results.length} runs`} />
        {h.rows.length === 0 && <p className="text-muted-foreground">No runs yet. Finish a test in Test Lab and it shows up here.</p>}
        {h.rows.length > 0 && (
          <Table className="text-[13px]" data-testid="history-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Scenario</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead>Pass rate</TableHead>
                <TableHead>Transcript errors (customer)</TableHead>
                <TableHead>Transcript errors (crew)</TableHead>
                <TableHead>Roles right</TableHead>
                <TableHead>Speed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {h.rows.map((r) => (
                <TableRow key={r.scenario}>
                  <TableCell className="font-medium">{r.scenario}</TableCell>
                  <TableCell className="tabular-nums">{r.runs}</TableCell>
                  <TableCell className="tabular-nums">{pct(r.passRate)}</TableCell>
                  <TableCell className="tabular-nums">{pct(r.werCustomer)}</TableCell>
                  <TableCell className="tabular-nums">{pct(r.werCrew)}</TableCell>
                  <TableCell className="tabular-nums">{pct(r.roleAccuracy)}</TableCell>
                  <TableCell className="tabular-nums">{secs(r.speedMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section>
        <SectionHeader title="Recent runs" details="Newest first" />
        <div className="tracks text-[13px]">
          {h.results.slice(0, 50).map((r) => (
            <div key={r.id} className="grid grid-cols-[150px_minmax(0,1fr)_150px_200px_70px] items-center gap-3 px-2 py-1.5">
              <span className="tabular-nums text-muted-foreground">{new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="truncate">{r.scenario_id.replace(/_/g, " ")}</span>
              <span className="text-muted-foreground">{MODE_NAMES[r.tester_mode] ?? r.tester_mode}</span>
              <span className="truncate text-muted-foreground">
                {r.input === "text" ? "typed" : r.stt} · {r.extractor}
              </span>
              <Badge value={r.pass ? "pass" : "fail"} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
