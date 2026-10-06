"use client";

import type { TruthRow } from "@serv/pipeline";
import { cn } from "@/lib/utils";
import { Badge } from "../Badge";
import { SectionHeader } from "../SectionHeader";

/** Where a difference came from (step 7's scorecard fills this in; the run page shows plain differences). */
export type Attribution = "heard wrong" | "understood wrong" | "timing";

type Name = (id: string | null) => string;

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** "missing item spicy_chicken|x1|-||" -> "Missing: 1 Spicy Chicken Sandwich". */
export function diffText(d: string, name: Name): string {
  const item = /^(missing|extra) item ([^|]+)\|x(\d+)\|([^|]*)\|/.exec(d);
  if (item) {
    const [, kind, id, q, size] = item;
    return `${kind === "missing" ? "Missing" : "Extra"}: ${q} ${size && size !== "-" ? `${size} ` : ""}${name(id ?? null)}`;
  }
  const no = /^(missing|extra) not_ordered ([^:]+):(\w+)/.exec(d);
  if (no) return `${no[1] === "missing" ? "Missing from" : "Extra in"} not ordered: ${no[2] === "?" ? "unknown item" : name(no[2] ?? null)} (${no[3]})`;
  return d.replace(/_/g, " ");
}

/** Expected (the script) against extracted (the order), side by side, every difference labeled. */
export function ExpectedVsExtracted({ rows, name, attribution }: { rows: TruthRow[]; name: Name; attribution?: (row: number, diff: string) => Attribution | undefined }) {
  const passed = rows.filter((r) => r.comparison.pass).length;
  return (
    <section data-testid="expected-vs-extracted">
      <SectionHeader
        title="Expected vs Extracted"
        details={`The script says what was ordered, so this run is scored automatically: ${passed} of ${rows.length} order${rows.length === 1 ? "" : "s"} match. No review needed.`}
      />
      <div className="space-y-4">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg border border-line p-3 text-[13px]">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">Order {i + 1}</span>
              {r.span && (
                <span className="text-[12px] text-muted-foreground">
                  {fmt(r.span.start_s)} to {fmt(r.span.end_s)}
                </span>
              )}
              <Badge value={r.comparison.pass ? "pass" : "fail"} label={r.comparison.pass ? "Match" : `${r.comparison.diffs.length} difference${r.comparison.diffs.length === 1 ? "" : "s"}`} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Side title="Expected" order={r.expected ? { status: r.expected.status, flags: r.expected.flags, items: r.expected.items.map((x) => ({ id: x.catalog_id, q: x.quantity, size: x.size ?? null })), notOrdered: r.expected.not_ordered.map((x) => `${name(x.catalog_id)} (${x.reason})`), unclear: r.expected.needs_review.length } : null} name={name} diffs={r.comparison.diffs} side="missing" />
              <Side
                title="Extracted"
                order={
                  r.actual
                    ? {
                        status: r.actual.status,
                        flags: r.actual.flags.filter((f) => f !== "placeholder_values"),
                        items: r.actual.items.map((x) => ({ id: x.catalog_id, q: x.quantity, size: x.size })),
                        notOrdered: r.actual.not_ordered.map((x) => `${x.catalog_id ? name(x.catalog_id) : (x.raw_text ?? "?")} (${x.reason})`),
                        unclear: r.actual.needs_review.length,
                      }
                    : null
                }
                name={name}
                diffs={r.comparison.diffs}
                side="extra"
              />
            </div>
            {r.comparison.diffs.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {r.comparison.diffs.map((d) => {
                  const where = attribution?.(i, d);
                  return (
                    <li key={d} className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-destructive/12 px-1.5 py-0.5 text-[11px] font-semibold text-destructive">{where ?? "difference"}</span>
                      <span>{diffText(d, name)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

interface SideOrder {
  status: string;
  flags: string[];
  items: { id: string; q: number; size: string | null }[];
  notOrdered: string[];
  unclear: number;
}

function Side({ title, order, name, diffs, side }: { title: string; order: SideOrder | null; name: Name; diffs: string[]; side: "missing" | "extra" }) {
  return (
    <div className="rounded-md bg-muted/50 p-2.5">
      <div className="label pb-1 text-[10.5px]">{title}</div>
      {!order && <p className="text-muted-foreground">{side === "missing" ? "Nothing expected here." : "No order was made."}</p>}
      {order && (
        <div className="space-y-1">
          {order.items.map((x, k) => {
            const off = diffs.some((d) => d.startsWith(`${side} item ${x.id}|x${x.q}|`));
            return (
              <div key={k} className={cn("rounded px-1", off && "bg-destructive/12 text-destructive")}>
                {x.q} {x.size ? `${x.size} ` : ""}
                {name(x.id)}
              </div>
            );
          })}
          {!order.items.length && <div className="text-muted-foreground">No items</div>}
          {order.unclear > 0 && <div className="text-muted-foreground">{order.unclear} unclear</div>}
          {order.notOrdered.length > 0 && <div className="text-muted-foreground">Not ordered: {order.notOrdered.join(", ")}</div>}
          <div className={cn("text-muted-foreground", diffs.some((d) => d.startsWith("status:")) && "text-destructive")}>Status: {order.status}</div>
          {order.flags.length > 0 && <div className={cn("text-muted-foreground", diffs.some((d) => d.startsWith("flags:")) && "text-destructive")}>Flags: {order.flags.join(", ")}</div>}
        </div>
      )}
    </div>
  );
}
