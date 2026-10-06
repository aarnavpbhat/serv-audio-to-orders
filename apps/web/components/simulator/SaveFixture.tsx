"use client";

import type { Catalog } from "@serv/pipeline/menu/catalog";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";

type Status = "completed" | "cancelled" | "abandoned" | "undetermined";
interface Item {
  catalog_id: string;
  quantity: number;
  size: "small" | "medium" | "large" | null;
}
interface Expected {
  status: Status;
  items: Item[];
}

const SELECT = "h-8 rounded-md border border-input bg-transparent px-2 text-[13px]";

/**
 * Save the finished session as a fixture: the server writes the raw capture,
 * audio and timeline; this form adds the expected order(s), written by hand.
 * "Held out" stores it apart, never used for tuning (plan D8).
 */
export function SaveFixture({
  catalog,
  storeId,
  laneId,
  session,
  labels,
}: {
  catalog: Catalog;
  storeId: string;
  laneId: string;
  session: { since: number; until: number | null } | null;
  labels: { current: { start_ms: number; end_ms: number; speaker: "crew" }[] };
}) {
  const options = [...catalog.menu.combos.map((c) => ({ id: c.id, name: c.name })), ...catalog.menu.items.map((i) => ({ id: i.id, name: i.name }))];
  const [fixtureName, setFixtureName] = useState("");
  const [heldOut, setHeldOut] = useState(false);
  const [orders, setOrders] = useState<Expected[]>([{ status: "completed", items: [] }]);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!session?.until;

  const update = (i: number, f: (o: Expected) => Expected) => setOrders(orders.map((o, k) => (k === i ? f(o) : o)));

  async function save(): Promise<void> {
    if (!session?.until) return;
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/dev/simulator/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: fixtureName, storeId, laneId, since: session.since, until: session.until, heldOut, expected: orders, speakerLabels: labels.current }),
    });
    const body = (await res.json().catch(() => ({}))) as { dir?: string; audioSeconds?: number; lines?: number; error?: { message?: string } };
    setBusy(false);
    setResult(res.ok ? { ok: true, text: `Saved to ${body.dir} (${body.audioSeconds ?? 0} s of audio, ${body.lines ?? 0} typed lines)` } : { ok: false, text: body.error?.message ?? `Save failed (${res.status})` });
  }

  return (
    <section>
      <h2 className="section-title mb-2">Save as Fixture</h2>
      <Card className="gap-4 px-5 py-4 text-[13px]">
        {!ready && <p className="text-muted-foreground">Stop the session first. Saving reads what the endpoint captured, so the last connection must be closed.</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Input value={fixtureName} onChange={(e) => setFixtureName(e.target.value)} placeholder="fixture name, e.g. sim_coke_to_sprite" className="h-8 w-72" aria-label="Fixture name" />
          <label className="flex items-center gap-2">
            <Checkbox checked={heldOut} onCheckedChange={(v) => setHeldOut(v === true)} aria-label="Held out" />
            Held out (fixtures/heldout/, never used for tuning)
          </label>
        </div>

        {orders.map((o, i) => (
          <div key={i} className="space-y-2 rounded-lg bg-muted/50 p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">Expected order {i + 1}</span>
              <select className={SELECT} value={o.status} onChange={(e) => update(i, (x) => ({ ...x, status: e.target.value as Status }))} aria-label={`Order ${i + 1} status`}>
                {(["completed", "cancelled", "abandoned", "undetermined"] as const).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              {orders.length > 1 && (
                <Button variant="ghost" size="sm" onClick={() => setOrders(orders.filter((_, k) => k !== i))}>
                  Remove order
                </Button>
              )}
            </div>
            {o.items.map((it, j) => (
              <div key={j} className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={it.quantity}
                  onChange={(e) => update(i, (x) => ({ ...x, items: x.items.map((y, k) => (k === j ? { ...y, quantity: Math.max(1, Number(e.target.value) || 1) } : y)) }))}
                  className="h-8 w-16"
                  aria-label="Quantity"
                />
                <select className={`${SELECT} min-w-64`} value={it.catalog_id} onChange={(e) => update(i, (x) => ({ ...x, items: x.items.map((y, k) => (k === j ? { ...y, catalog_id: e.target.value } : y)) }))} aria-label="Item">
                  {options.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <select
                  className={SELECT}
                  value={it.size ?? ""}
                  onChange={(e) => update(i, (x) => ({ ...x, items: x.items.map((y, k) => (k === j ? { ...y, size: (e.target.value || null) as Item["size"] } : y)) }))}
                  aria-label="Size"
                >
                  <option value="">no size</option>
                  <option>small</option>
                  <option>medium</option>
                  <option>large</option>
                </select>
                <Button variant="ghost" size="sm" onClick={() => update(i, (x) => ({ ...x, items: x.items.filter((_, k) => k !== j) }))}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => update(i, (x) => ({ ...x, items: [...x.items, { catalog_id: options[0]?.id ?? "", quantity: 1, size: null }] }))}>
              Add item
            </Button>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setOrders([...orders, { status: "completed", items: [] }])}>
            Add another order
          </Button>
          <Button disabled={!ready || busy || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(fixtureName)} onClick={() => void save()}>
            {busy ? "Saving" : "Save fixture"}
          </Button>
          {result && <span className={result.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>{result.text}</span>}
        </div>
      </Card>
    </section>
  );
}
