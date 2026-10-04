"use client";

import type { AppliedEvent } from "@serv/pipeline/build/replay";
import type { ComboOpportunity, NeedsReviewItem, NotOrderedItem, OrderEvent, OrderItem } from "@serv/pipeline/schemas/index";
import { Badge, Flag } from "../Badge";
import { JsonView } from "../JsonView";

export interface PanelOrder {
  order_id: string;
  status: string | null;
  group_id: string | null;
  items: OrderItem[];
  needs_review: NeedsReviewItem[];
  not_ordered: NotOrderedItem[];
  combo_opportunities: ComboOpportunity[];
  flags: string[];
  totals: { computed: number; spoken_by_crew: number | null };
  overall_confidence: number;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function ItemRow({ item, name }: { item: OrderItem; name: (id: string | null) => string }) {
  const mods = item.modifiers.map((m) => m.id);
  return (
    <li className="rounded-lg border border-emerald-200 bg-white p-2 text-sm">
      <div className="flex justify-between gap-2">
        <span className="font-medium">
          {item.quantity} x {item.name}
          {item.size && <span className="ml-1 text-xs text-muted">({item.size})</span>}
        </span>
        <span className="tabular-nums text-muted">{money(item.unit_price * item.quantity)}</span>
      </div>
      {item.components && (
        <div className="mt-1 space-y-0.5 text-xs text-muted">
          {item.components.map((c) => (
            <div key={c.slot}>
              <span className="uppercase">{c.slot}</span>: {c.catalog_id ? name(c.catalog_id) : c.declined ? "none (declined)" : <span className="font-medium text-rose-700">not chosen</span>}
              {c.modifiers?.length ? <span className="ml-1">· {c.modifiers.map((m) => m.id).join(", ")}</span> : null}
            </div>
          ))}
        </div>
      )}
      {mods.length > 0 && <div className="mt-1 text-xs text-muted">{mods.join(", ")}</div>}
      <div className="mt-1 flex gap-3 font-mono text-[10px] text-muted">
        <span>rec {pct(item.recognition_confidence)}</span>
        <span>com {pct(item.commitment_confidence)}</span>
        <span>{item.source_utterance_ids.join(" ")}</span>
      </div>
    </li>
  );
}

export function OrderCard({
  order,
  phase,
  name,
}: {
  order: PanelOrder;
  phase: "final" | "live" | "waiting";
  name: (id: string | null) => string;
}) {
  const flags = order.flags.filter((f) => f !== "placeholder_values");
  return (
    <div className={`rounded-xl border p-3 ${phase === "waiting" ? "border-dashed border-line opacity-60" : "border-line bg-slate-50/50"}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted">{order.order_id}</span>
        {phase === "final" && order.status && <Badge value={order.status} />}
        {phase === "live" && <Badge value="running" label="building..." />}
        {phase === "waiting" && <Badge value="queued" label="not reached yet" />}
        {order.group_id && <span className="rounded bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] text-sky-700">group {order.group_id.slice(-6)}</span>}
        <span className="ml-auto text-sm tabular-nums">
          {money(order.totals.computed)}
          {order.totals.spoken_by_crew !== null && (
            <span className={`ml-1 text-xs ${Math.abs(order.totals.spoken_by_crew - order.totals.computed) > 0.05 ? "text-rose-700" : "text-muted"}`}>
              (crew said {money(order.totals.spoken_by_crew)})
            </span>
          )}
        </span>
      </div>
      {(flags.length > 0 || order.flags.includes("placeholder_values")) && (
        <div className="mb-2 flex flex-wrap gap-1">
          {flags.map((f) => (
            <Flag key={f} value={f} />
          ))}
          {order.flags.includes("placeholder_values") && <Flag value="placeholder_values" />}
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-3">
        <div>
          <div className="label mb-1 text-emerald-700">Items ({order.items.length})</div>
          <ul className="space-y-1.5">
            {order.items.map((i) => (
              <ItemRow key={i.line_id} item={i} name={name} />
            ))}
          </ul>
        </div>
        <div>
          <div className="label mb-1 text-amber-700">Needs review ({order.needs_review.length})</div>
          <ul className="space-y-1.5">
            {order.needs_review.map((n) => (
              <li key={n.line_id} className="rounded-lg border border-amber-200 bg-white p-2 text-sm">
                <div className="font-medium">
                  {n.quantity} x &ldquo;{n.raw_text ?? name(n.catalog_id)}&rdquo;
                </div>
                <div className="mt-1 space-y-0.5 text-xs">
                  {n.candidates.map((c) => (
                    <div key={c.catalog_id} className="flex justify-between">
                      <span>{name(c.catalog_id)}</span>
                      <span className="font-mono text-muted">{c.score.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="label mb-1 text-slate-600">Not ordered ({order.not_ordered.length})</div>
          <ul className="space-y-1.5">
            {order.not_ordered.map((n, k) => (
              <li key={k} className="rounded-lg border border-line bg-white p-2 text-sm">
                <div className="text-slate-500 line-through">{name(n.catalog_id) || n.raw_text}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {n.reason.replace(/_/g, " ")}
                  {n.replaced_by ? ` by ${name(n.replaced_by)}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {order.combo_opportunities.length > 0 && (
        <div className="mt-2 space-y-1">
          {order.combo_opportunities.map((c, k) => (
            <div key={k} className="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs text-indigo-900">
              Combo opportunity: {c.combo_name} would cost {money(c.combo_price)} instead of {money(c.separate_total)} (save {money(c.savings)})
              {c.customer_declined_combo && <span className="ml-1 font-semibold">· customer declined the meal</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EventLog({ events, log, time }: { events: OrderEvent[]; log: AppliedEvent[]; time: number | null }) {
  const notes = new Map(log.map((l) => [l.event_id, l]));
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">Events ({events.length}): the LLM proposes, code decides</summary>
      <ol className="mt-2 space-y-1 font-mono text-[11px]">
        {events.map((e) => {
          const l = notes.get(e.event_id);
          const reached = time === null || e.t_s === null || e.t_s <= time;
          return (
            <li key={e.event_id} className={`flex gap-2 rounded px-2 py-1 ${reached ? "bg-white" : "opacity-40"} ${l && !l.applied ? "text-rose-700" : ""}`}>
              <span className="w-8 text-muted">{e.event_id}</span>
              <span className="w-32 font-semibold">{e.type}</span>
              <span className="flex-1">
                {[e.catalog_id ?? (e.raw_text ? `"${e.raw_text}"` : null), e.quantity ? `x${e.quantity}` : null, e.size, e.slot && `slot=${e.slot}`, e.target_line_ref && `-> ${e.target_line_ref}`, e.modifiers.length ? e.modifiers.join(",") : null, e.amount !== null ? `$${e.amount}` : null]
                  .filter(Boolean)
                  .join(" ")}
                {l && <span className="ml-2 text-muted">· {l.note}</span>}
              </span>
              <span className="text-muted">
                r{Math.round(e.recognition_confidence * 100)} c{Math.round(e.commitment_confidence * 100)}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export { JsonView };
