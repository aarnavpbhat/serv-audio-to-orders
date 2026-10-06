import Link from "next/link";
import { Badge } from "@/components/Badge";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { listOrders, menuJson, type OrderFilters } from "@/lib/data";
import { Catalog } from "@serv/pipeline/menu/catalog";

export const dynamic = "force-dynamic";

const STATUSES = ["completed", "cancelled", "abandoned", "undetermined"];
const SELECT = "h-8 rounded-md border border-input bg-transparent px-2 text-[13px]";

/** Every order (latest version), read-only and filterable. The review queue holds only the flagged ones. */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const f: OrderFilters = {
    ...(q.status && STATUSES.includes(q.status) ? { status: q.status } : {}),
    ...(q.review === "yes" || q.review === "no" ? { review: q.review } : {}),
    ...(q.store ? { store: q.store } : {}),
    ...(q.lane ? { lane: q.lane } : {}),
    ...(q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? { date: q.date } : {}),
  };
  const all = listOrders({});
  const rows = listOrders(f);
  const stores = [...new Set(all.map((o) => o.payload.store_id))].sort();
  const lanes = [...new Set(all.map((o) => o.payload.lane_id))].sort();
  const catalog = Catalog.fromJson(menuJson());
  const name = (id: string | null) => (id && catalog.has(id) ? catalog.name(id) : (id ?? "?"));

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-8 pb-16 pt-8">
      <header>
        <h1 className="title-xl">Orders</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">Every order the pipeline sent, latest version, newest first. Read only: orders that need a person are in Review.</p>
      </header>

      <form className="flex flex-wrap items-end gap-3 text-[13px]" method="get">
        <Filter label="Status">
          <select name="status" defaultValue={f.status ?? ""} className={SELECT} aria-label="Status">
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Filter>
        <Filter label="Review">
          <select name="review" defaultValue={f.review ?? ""} className={SELECT} aria-label="Review">
            <option value="">Any</option>
            <option value="yes">Flagged</option>
            <option value="no">Not flagged</option>
          </select>
        </Filter>
        <Filter label="Store">
          <select name="store" defaultValue={f.store ?? ""} className={SELECT} aria-label="Store">
            <option value="">Any</option>
            {stores.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Lane">
          <select name="lane" defaultValue={f.lane ?? ""} className={SELECT} aria-label="Lane">
            <option value="">Any</option>
            {lanes.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Filter>
        <Filter label="Date">
          <input type="date" name="date" defaultValue={f.date ?? ""} className={SELECT} aria-label="Date" />
        </Filter>
        <Button type="submit" size="sm">
          Filter
        </Button>
        <Link href="/orders" className="pb-1.5 text-[12px] text-brand hover:underline">
          Clear
        </Link>
      </form>

      <section>
        <SectionHeader title="Orders" details={`${rows.length} shown${rows.length === 300 ? " (the newest 300)" : ""}`} />
        {rows.length === 0 && <p className="text-muted-foreground">No orders match.</p>}
        {rows.length > 0 && (
          <Table className="table-fixed text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[150px]">Started</TableHead>
                <TableHead className="w-[160px]">Store / lane</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[90px]">Review</TableHead>
                <TableHead className="w-[60px]">Version</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ payload: p, run_id }) => (
                <TableRow key={p.order_id}>
                  <TableCell className="tabular-nums text-muted-foreground">{new Date(p.times.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</TableCell>
                  <TableCell className="truncate">
                    {p.store_id} / {p.lane_id}
                  </TableCell>
                  <TableCell className="truncate">
                    <Link href={`/runs/${run_id}`} className="hover:text-brand hover:underline">
                      {p.items.map((i) => `${i.quantity} ${name(i.catalog_id)}`).join(", ") || "No items"}
                      {p.needs_review.length > 0 && ` + ${p.needs_review.length} unclear`}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge value={p.status} />
                  </TableCell>
                  <TableCell>{p.review.required ? <Badge value="review" label="Flagged" /> : <span className="text-muted-foreground">No</span>}</TableCell>
                  <TableCell className="tabular-nums">v{p.order_version}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="label block text-[10.5px]">{label}</span>
      {children}
    </label>
  );
}
