"use client";

import type { AppliedEvent } from "@serv/pipeline/build/replay";
import type { ComboOpportunity, NeedsReviewItem, NotOrderedItem, OrderEvent, OrderItem, OutcomeEvidence, Review } from "@serv/pipeline/schemas/index";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/Collapsible";
import { cn } from "@/lib/utils";
import { Badge, Flag } from "../Badge";
import { Equalizer } from "../Icons";
import { JsonView } from "../JsonView";

export interface PanelOrder {
  order_id: string;
  status: string | null;
  review: Review | null;
  outcome_evidence: OutcomeEvidence[];
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

const ROW = "grid grid-cols-[28px_minmax(0,1fr)_auto_72px] items-center gap-3 px-2 py-1.5";

function Confidence({ rec, com }: { rec: number; com: number }) {
  return (
    <span className="flex gap-2 font-mono text-[10.5px] text-muted-foreground" title="recognition / commitment confidence">
      <span>rec {pct(rec)}</span>
      <span>com {pct(com)}</span>
    </span>
  );
}

function ItemRow({ n, item, name }: { n: number; item: OrderItem; name: (id: string | null) => string }) {
  const details = [
    item.size,
    ...(item.components ?? []).map((c) => `${c.slot}: ${c.catalog_id ? name(c.catalog_id) : c.declined ? "declined" : "NOT CHOSEN"}${c.modifiers?.length ? ` (${c.modifiers.map((m) => m.id).join(", ")})` : ""}`),
    ...item.modifiers.map((m) => m.id.replace(/_/g, " ")),
  ].filter(Boolean);
  const missing = item.components?.some((c) => !c.catalog_id && !c.declined);
  return (
    <div className={ROW}>
      <span className="text-center text-[12px] tabular-nums text-muted-foreground">{n}</span>
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {item.name}
          {item.quantity > 1 && <span className="ml-1.5 text-muted-foreground">×{item.quantity}</span>}
        </span>
        {details.length > 0 && <span className={`block truncate text-[11.5px] ${missing ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>{details.join(" · ")}</span>}
      </span>
      <Confidence rec={item.recognition_confidence} com={item.commitment_confidence} />
      <span className="text-right tabular-nums">{money(item.unit_price * item.quantity)}</span>
    </div>
  );
}

export function OrderCard({ order, phase, name }: { order: PanelOrder; phase: "final" | "live" | "waiting"; name: (id: string | null) => string }) {
  const flags = order.flags.filter((f) => f !== "placeholder_values");
  const spoken = order.totals.spoken_by_crew;
  const mismatch = spoken !== null && Math.abs(spoken - order.totals.computed) > 0.05;
  return (
    <div className={phase === "waiting" ? "opacity-45" : ""}>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-1.5">
        <span className="font-mono text-[11px] text-muted-foreground">{order.order_id}</span>
        {phase === "final" && order.status && <Badge value={order.status} />}
        {phase === "final" && order.review?.required && <Badge value="review" label={`Review: ${order.review.reasons.map((r) => r.replace(/_/g, " ")).join(", ")}`} />}
        {phase === "live" && (
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-brand">
            <Equalizer /> Building
          </span>
        )}
        {phase === "waiting" && <Badge value="queued" label="Not reached yet" />}
        {order.group_id && <span className="rounded bg-sky-500/12 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:text-sky-400">group {order.group_id.slice(-6)}</span>}
        {flags.map((f) => (
          <Flag key={f} value={f} />
        ))}
        {order.flags.includes("placeholder_values") && <Flag value="placeholder_values" />}
      </div>

      <div className="tracks text-[13px]">
        {order.items.map((i, k) => (
          <ItemRow key={i.line_id} n={k + 1} item={i} name={name} />
        ))}
        {order.needs_review.map((n) => (
          <div key={n.line_id} className={ROW}>
            <span className="grid place-items-center">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-amber-500 text-[10px] font-bold text-white">?</span>
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">
                &ldquo;{n.raw_text ?? name(n.catalog_id)}&rdquo;
                {n.quantity > 1 && <span className="ml-1.5 text-muted-foreground">×{n.quantity}</span>}
              </span>
              <span className="block truncate text-[11.5px] text-amber-700 dark:text-amber-400">
                Needs review{n.candidates.length > 0 && `: ${n.candidates.map((c) => `${name(c.catalog_id)} ${c.score.toFixed(2)}`).join(", ")}`}
              </span>
            </span>
            <span />
            <span className="text-right text-muted-foreground">-</span>
          </div>
        ))}
        {order.not_ordered.map((n, k) => (
          <div key={`no${k}`} className={ROW}>
            <span className="text-center text-muted-foreground">-</span>
            <span className="min-w-0">
              <span className="block truncate text-muted-foreground line-through">{name(n.catalog_id) || n.raw_text}</span>
              <span className="block truncate text-[11.5px] text-muted-foreground">
                {n.reason.replace(/_/g, " ")}
                {n.replaced_by ? ` by ${name(n.replaced_by)}` : ""}
              </span>
            </span>
            <span />
            <span />
          </div>
        ))}
        {order.items.length + order.needs_review.length + order.not_ordered.length === 0 && <div className="px-2 py-2 text-muted-foreground">Nothing ordered yet.</div>}
      </div>

      {order.combo_opportunities.map((c, k) => (
        <div key={k} className="mx-2 mt-2 rounded-lg bg-brand-soft px-3 py-1.5 text-[12px]">
          <span className="font-semibold text-brand">Combo opportunity:</span> {c.combo_name} would cost {money(c.combo_price)} instead of {money(c.separate_total)}, saving {money(c.savings)}
          {c.customer_declined_combo && <span className="font-semibold"> · customer declined the meal</span>}
        </div>
      ))}

      {phase === "final" && (order.outcome_evidence ?? []).length > 0 && <Evidence list={order.outcome_evidence} />}

      <div className="mt-1 flex items-center justify-end gap-3 border-t border-line px-2 pt-2 text-[12px]">
        <span className="text-muted-foreground">confidence {pct(order.overall_confidence)}</span>
        {spoken !== null && <span className={mismatch ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground"}>crew said {money(spoken)}</span>}
        <span className="text-[14px] font-semibold tabular-nums">{money(order.totals.computed)}</span>
      </div>
    </div>
  );
}

/** Why the status is what it is; context-only entries never decided it. */
function Evidence({ list }: { list: OutcomeEvidence[] }) {
  return (
    <div className="mx-2 mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
      <span className="font-medium text-foreground">Outcome evidence:</span>
      {list.map((e, k) => (
        <span key={k} className={e.context_only ? "opacity-60" : undefined}>
          {e.type === "spoken_cue" ? `"${e.cue}" (${e.kind?.replace(/_/g, " ")})` : e.type === "silence" ? `silence ${e.duration_s}s` : (e.event ?? e.type).replace(/_/g, " ")}
          {e.context_only ? " · context only" : ""}
        </span>
      ))}
    </div>
  );
}

export function EventLog({ events, log, time }: { events: OrderEvent[]; log: AppliedEvent[]; time: number | null }) {
  const notes = new Map(log.map((l) => [l.event_id, l]));
  return (
    <Collapsible className="group/events mt-2 px-2">
      <CollapsibleTrigger className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/events:rotate-90" />
        Events ({events.length}): the LLM proposes, code decides
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="tracks mt-2 font-mono text-[11px]">
          {events.map((e) => {
            const l = notes.get(e.event_id);
            const reached = time === null || e.t_s === null || e.t_s <= time;
            return (
              <li key={e.event_id} className={cn("flex gap-2 px-2 py-1", !reached && "opacity-35", l && !l.applied && "text-destructive")}>
                <span className="w-8 text-muted-foreground">{e.event_id}</span>
                <span className="w-32 font-semibold">{e.type}</span>
                <span className="flex-1">
                  {[e.catalog_id ?? (e.raw_text ? `"${e.raw_text}"` : null), e.quantity ? `x${e.quantity}` : null, e.size, e.slot && `slot=${e.slot}`, e.target_line_ref && `-> ${e.target_line_ref}`, e.modifiers.length ? e.modifiers.join(",") : null, e.amount !== null ? `$${e.amount}` : null]
                    .filter(Boolean)
                    .join(" ")}
                  {l && <span className="ml-2 text-muted-foreground">· {l.note}</span>}
                </span>
                <span className="text-muted-foreground">
                  r{Math.round(e.recognition_confidence * 100)} c{Math.round(e.commitment_confidence * 100)}
                </span>
              </li>
            );
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

export { JsonView };
