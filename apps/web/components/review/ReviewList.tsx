"use client";

import type { OrderPayload } from "@serv/pipeline";
import { Catalog } from "@serv/pipeline/menu/catalog";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import type { ReviewOrder } from "@/lib/data";
import { reviewReasonText } from "@/lib/review-text";
import { Badge } from "../Badge";
import { OrderCard } from "../run/OrderPanel";

type Status = OrderPayload["status"];
const STATUSES: Status[] = ["completed", "cancelled", "abandoned", "undetermined"];
const SELECT = "h-8 rounded-md border border-input bg-transparent px-2 text-[13px]";
const DROP = "__drop__";
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

const noSubscribe = () => () => {};
function readReviewer(): string {
  try {
    return localStorage.getItem("serv.reviewer") ?? "";
  } catch {
    return "";
  }
}

/** Orders that need a person's review; resolving one sends the next version as order.updated. */
export function ReviewList({ orders, menu }: { orders: ReviewOrder[]; menu: unknown }) {
  const catalog = useMemo(() => Catalog.fromJson(menu), [menu]);
  const name = useCallback((cid: string | null) => (cid ? catalog.name(cid) : ""), [catalog]);
  // The reviewer's name is remembered in this browser (read after hydration; empty on the server).
  const stored = useSyncExternalStore(noSubscribe, readReviewer, () => "");
  const [typed, setTyped] = useState<string | null>(null);
  const author = typed ?? stored;
  const saveAuthor = (v: string) => {
    setTyped(v);
    try {
      localStorage.setItem("serv.reviewer", v);
    } catch {
      // not remembered, still used
    }
  };

  return (
    <div className="mx-auto max-w-[1180px] space-y-8 px-8 pb-16 pt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title-xl">Review</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
            Orders the pipeline flagged, where nobody knows the right answer without listening (fixture runs are scored against their script instead). Listen to the flagged lines, fix what was wrong,
            and save: the next version goes to the webhook as order.updated. Every order, flagged or not, is on the Orders page.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Reviewer
          <Input value={author} onChange={(e) => saveAuthor(e.target.value)} placeholder="your name" className="h-8 w-44" aria-label="Reviewer" />
        </label>
      </header>
      {orders.length === 0 && <p className="text-[13px] text-muted-foreground">Nothing needs review.</p>}
      {orders.map((o) => (
        <ReviewCard key={o.payload.order_id} order={o} catalog={catalog} name={name} author={author} />
      ))}
    </div>
  );
}

function ReviewCard({ order, catalog, name, author }: { order: ReviewOrder; catalog: Catalog; name: (id: string | null) => string; author: string }) {
  const router = useRouter();
  const p = order.payload;
  const [choices, setChoices] = useState<Record<string, string>>(() => Object.fromEntries(p.needs_review.map((n) => [n.line_id, n.candidates[0]?.catalog_id ?? DROP])));
  const [status, setStatus] = useState<Status>(p.status === "undetermined" ? "completed" : p.status);
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const flagged = useMemo(() => {
    const ids = new Set(p.needs_review.flatMap((n) => n.source_utterance_ids));
    return ids.size ? ids : new Set(p.transcript.map((u) => u.id));
  }, [p]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const menuOptions = [...catalog.menu.combos.map((c) => ({ id: c.id, name: c.name })), ...catalog.menu.items.map((i) => ({ id: i.id, name: i.name }))];

  /** "Looks right" keeps the order as sent (each unclear item as its top candidate) and clears the flag. */
  async function save(looksRight = false): Promise<void> {
    setBusy(true);
    setResult(null);
    const picks = looksRight ? Object.fromEntries(p.needs_review.map((n) => [n.line_id, n.candidates[0]?.catalog_id ?? DROP])) : choices;
    const items = Object.fromEntries(Object.entries(picks).map(([line, c]) => [line, c === DROP ? null : c]));
    const kept = new Set([...p.items.map((i) => i.line_id), ...Object.entries(items).filter(([, c]) => c).map(([l]) => l)]);
    const quantities = looksRight ? {} : Object.fromEntries(Object.entries(qty).filter(([l]) => kept.has(l)));
    const text = looksRight ? ["Looks right", note.trim()].filter(Boolean).join(": ") : note.trim();
    const res = await fetch(`/api/orders/${encodeURIComponent(p.order_id)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: p.order_version, items, quantities, status: looksRight ? p.status : status, author: author.trim(), ...(text ? { note: text } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as { order_version?: number; error?: { message?: string } };
    setBusy(false);
    if (!res.ok) {
      setResult({ ok: false, text: body.error?.message ?? `Save failed (${res.status})` });
      return;
    }
    setResult({ ok: true, text: `Sent v${body.order_version} as order.updated` });
    router.refresh();
  }

  return (
    <Card id={p.order_id} className="gap-4 px-5 py-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11.5px] text-muted-foreground">{p.order_id}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">v{p.order_version}</span>
        <Badge value={p.status} />
        <Badge value="review" label={`Review: ${p.review.reasons.map((r) => r.replace(/_/g, " ")).join(", ")}`} />
        <span className="ml-auto text-[12px] text-muted-foreground">
          {p.store_id} / {p.lane_id} · {clock(p.times.started_at)} to {clock(p.times.ended_at)} ·{" "}
          <Link href={`/runs/${order.run_id}`} className="text-brand hover:underline">
            run
          </Link>
        </span>
      </div>

      <div className="space-y-1">
        <div className="label text-[10.5px]">Why it was flagged</div>
        <ul className="list-disc space-y-0.5 pl-5">
          {reviewReasonText(p, name).map((t, i) => (
            // Two unclear items can read the same, so the index is the key.
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>

      {order.clip && (
      <div className="flex flex-wrap items-center gap-3">
        <audio controls preload="none" src={`/api/orders/${encodeURIComponent(p.order_id)}/clip?v=${p.order_version}`} className="h-8" aria-label="Flagged lines audio" />
        <span className="text-[12px] text-muted-foreground">The flagged lines, with 2 s before and after.</span>
      </div>
      )}
      {!order.clip && <p className="text-[12px] text-muted-foreground">No audio was kept for this order (typed lines, or archiving was off).</p>}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-1 rounded-lg bg-muted/50 p-3">
          <div className="label pb-1 text-[10.5px]">What was said (flagged lines in bold)</div>
          {p.transcript.map((u) => (
            <div key={u.id} className={cn("flex gap-2", u.non_customer && "opacity-50", flagged.has(u.id) && "font-semibold")}>
              <span className={cn("w-20 shrink-0 text-[11px] font-semibold uppercase tracking-wide", u.speaker === "crew" ? "text-crew" : "text-customer")}>
                {u.speaker}
                {u.speaker_guessed ? "?" : ""}
              </span>
              <span>{u.text}</span>
            </div>
          ))}
        </div>
        <OrderCard order={p} phase="final" name={name} />
      </div>

      <div className="space-y-3 border-t border-line pt-3">
        {p.needs_review.map((n) => (
          <div key={n.line_id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-56">
              &ldquo;{n.raw_text ?? name(n.catalog_id)}&rdquo;{n.quantity > 1 ? ` ×${n.quantity}` : ""}
            </span>
            <span className="text-muted-foreground">was</span>
            <select className={cn(SELECT, "min-w-64")} value={choices[n.line_id]} onChange={(e) => setChoices({ ...choices, [n.line_id]: e.target.value })} aria-label={`What "${n.raw_text ?? n.line_id}" was`}>
              <optgroup label="Candidates">
                {n.candidates.map((c) => (
                  <option key={c.catalog_id} value={c.catalog_id}>
                    {name(c.catalog_id)} ({c.score.toFixed(2)})
                  </option>
                ))}
              </optgroup>
              <optgroup label="Menu">
                {menuOptions
                  .filter((m) => !n.candidates.some((c) => c.catalog_id === m.id))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </optgroup>
              <option value={DROP}>Not ordered (drop it)</option>
            </select>
            {choices[n.line_id] !== DROP && <Qty line={n.line_id} value={qty[n.line_id] ?? n.quantity} onChange={(v) => setQty({ ...qty, [n.line_id]: v })} />}
          </div>
        ))}
        {p.items.map((i) => (
          <div key={i.line_id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-56">{name(i.catalog_id)}</span>
            <Qty line={i.line_id} value={qty[i.line_id] ?? i.quantity} onChange={(v) => setQty({ ...qty, [i.line_id]: v })} />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-56">How the visit ended</span>
          <select className={SELECT} value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label="Outcome">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
                {s === p.status ? " (as sent)" : ""}
              </option>
            ))}
          </select>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" className="h-8 max-w-sm flex-1" aria-label="Note" />
          <Button disabled={busy || !author.trim()} onClick={() => void save()} title={author.trim() ? undefined : "Enter your name as reviewer first"}>
            {busy ? "Sending" : "Save and send update"}
          </Button>
          <Button variant="outline" disabled={busy || !author.trim()} onClick={() => void save(true)} title="Keep the order as sent and clear the flag (sends order.updated)">
            Looks right
          </Button>
          {result && <span className={result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{result.text}</span>}
        </div>
      </div>
    </Card>
  );
}

function Qty({ line, value, onChange }: { line: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      quantity
      <Input type="number" min={1} max={99} value={value} onChange={(e) => onChange(Math.max(1, Math.min(99, Number(e.target.value) || 1)))} className="h-8 w-16" aria-label={`Quantity for ${line}`} />
    </label>
  );
}
