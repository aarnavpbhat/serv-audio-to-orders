"use client";

import { Catalog } from "@serv/pipeline/menu/catalog";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

type Status = "completed" | "cancelled" | "abandoned" | "undetermined";
type Size = "small" | "medium" | "large";
export interface AnswerOrder {
  status: Status;
  items: { catalog_id: string; quantity: number; size?: Size | null }[];
}

const SELECT = "h-8 rounded-md border border-input bg-transparent px-2 text-[13px]";

/** Free play: "What was actually ordered?" The answer becomes the ground truth for scoring. */
export function FreePlayAnswer({ catalog, onScore, onSkip }: { catalog: Catalog; onScore: (orders: AnswerOrder[]) => void; onSkip: () => void }) {
  const [orders, setOrders] = useState<AnswerOrder[]>([{ status: "completed", items: [] }]);
  const menu = [...catalog.menu.items.map((i) => ({ id: i.id, name: i.name })), ...catalog.menu.combos.map((c) => ({ id: c.id, name: c.name }))];
  const [pick, setPick] = useState(menu[0]?.id ?? "");
  const set = (i: number, o: AnswerOrder) => setOrders(orders.map((x, j) => (j === i ? o : x)));
  return (
    <Card className="gap-4 px-5 py-4 text-[13px]">
      <div>
        <h2 className="section-title">What was actually ordered?</h2>
        <p className="text-muted-foreground">Your answer is the ground truth: the run is scored against it. Skip it, and any order the system flagged stays flagged on the Orders page.</p>
      </div>
      {orders.map((o, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Car {i + 1}</span>
            <select className={SELECT} value={o.status} onChange={(e) => set(i, { ...o, status: e.target.value as Status })} aria-label={`How car ${i + 1} ended`}>
              <option value="completed">completed</option>
              <option value="cancelled">cancelled</option>
              <option value="abandoned">abandoned (drove off)</option>
              <option value="undetermined">undetermined</option>
            </select>
          </div>
          {o.items.map((it, k) => {
            const sizes = catalog.menu.items.find((m) => m.id === it.catalog_id)?.sizes;
            return (
              <div key={k} className="flex flex-wrap items-center gap-2">
                <Input type="number" min={1} max={50} value={it.quantity} className="h-8 w-16" aria-label="Quantity" onChange={(e) => set(i, { ...o, items: o.items.map((x, j) => (j === k ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)) })} />
                <span className="min-w-48">{catalog.name(it.catalog_id)}</span>
                {sizes && (
                  <select className={SELECT} value={it.size ?? "medium"} aria-label="Size" onChange={(e) => set(i, { ...o, items: o.items.map((x, j) => (j === k ? { ...x, size: e.target.value as Size } : x)) })}>
                    {sizes.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                )}
                <Button size="sm" variant="ghost" onClick={() => set(i, { ...o, items: o.items.filter((_, j) => j !== k) })}>
                  Remove
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <select className={SELECT} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Menu item">
              {menu.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" onClick={() => set(i, { ...o, items: [...o.items, { catalog_id: pick, quantity: 1, ...(catalog.menu.items.find((m) => m.id === pick)?.sizes ? { size: "medium" as Size } : {}) }] })}>
              Add item
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setOrders([...orders, { status: "completed", items: [] }])}>
          Add another car
        </Button>
        <Button onClick={() => onScore(orders)}>Score this run</Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip (flagged orders go to Review)
        </Button>
      </div>
    </Card>
  );
}
