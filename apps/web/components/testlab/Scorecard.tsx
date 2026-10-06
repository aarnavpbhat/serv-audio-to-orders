"use client";

import type { Scenario } from "@serv/pipeline";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ScoreResponse } from "@/lib/testlab";
import { cn } from "@/lib/utils";
import { ExpectedVsExtracted } from "../review/ExpectedVsExtracted";

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

/** After each run: pass or fail, where it went wrong, and how well it heard. */
export function Scorecard({
  result,
  scenario,
  hasNext,
  name,
  run,
  onRetry,
  onNext,
}: {
  result: ScoreResponse;
  scenario: Scenario | null;
  hasNext: boolean;
  name: (id: string | null) => string;
  run: { storeId: string; laneId: string; since: number; until: number };
  onRetry: () => void;
  onNext: () => void;
}) {
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const where = (row: number, diff: string) => result.attribution.find((a) => a.row === row && a.diff === diff)?.where;

  async function save(heldOut: boolean): Promise<void> {
    setSaved(null);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const expected = (result.rows.map((r) => r.expected).filter(Boolean) as NonNullable<(typeof result.rows)[number]["expected"]>[]).map((o) => ({
      status: o.status,
      items: o.items.map((i) => ({ catalog_id: i.catalog_id, quantity: i.quantity, ...(i.size !== undefined ? { size: i.size } : {}) })),
    }));
    const res = await fetch("/api/dev/simulator/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `testlab_${scenario?.id ?? "free_play"}_${stamp}`, storeId: run.storeId, laneId: run.laneId, since: run.since, until: run.until, heldOut, expected, speakerLabels: [] }),
    });
    const body = (await res.json().catch(() => ({}))) as { dir?: string; error?: { message?: string } };
    setSaved(res.ok ? { ok: true, text: `Saved to ${body.dir}` } : { ok: false, text: body.error?.message ?? `Save failed (${res.status})` });
  }

  return (
    <div className="space-y-6" data-testid="scorecard">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className={cn("text-[34px] font-bold", result.pass ? "text-emerald-700 dark:text-emerald-400" : "text-destructive")}>{result.pass ? "Pass" : "Fail"}</h2>
        <span className="text-[14px] text-muted-foreground">
          {scenario ? `${scenario.number}. ${scenario.title}` : "Free play"} · {result.stt} · {result.extractor}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Transcript errors, customer" value={pct(result.wer.customer)} hint="Word error rate against the script (lower is better)" />
        <Metric label="Transcript errors, crew" value={pct(result.wer.crew)} hint="Word error rate against the script (lower is better)" />
        <Metric label="Speaker roles right" value={pct(result.roleAccuracy)} hint="Share of heard lines labeled with the right speaker" />
        <Metric label="Speed" value={result.speedMs === null ? "n/a" : `${(result.speedMs / 1000).toFixed(1)} s`} hint="Conversation end to order sent" />
      </div>

      {result.attribution.length > 0 && (
        <Card className="gap-1 px-4 py-3 text-[13px]">
          <div className="label text-[10.5px]">Where it went wrong</div>
          <p className="text-muted-foreground">
            Each difference was checked against the script&apos;s exact words. <b>Heard wrong</b>: the transcript was wrong (the perfect words gave the right answer). <b>Understood wrong</b>: extraction got it wrong even from the perfect words. <b>Timing</b>: the order was split, closed at the wrong time, or not reopened.
          </p>
        </Card>
      )}

      <ExpectedVsExtracted rows={result.rows} name={name} attribution={where} />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onRetry}>Retry</Button>
        {hasNext && (
          <Button variant="secondary" onClick={onNext}>
            Next test
          </Button>
        )}
        <Button variant="outline" onClick={() => void save(false)}>
          Save as fixture
        </Button>
        <Button variant="outline" onClick={() => void save(true)}>
          Save as held-out
        </Button>
        {saved && <span className={cn("text-[13px]", saved.ok ? "text-muted-foreground" : "font-medium text-destructive")}>{saved.text}</span>}
      </div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="gap-0.5 px-4 py-3" title={hint}>
      <div className="label text-[10.5px]">{label}</div>
      <div className="text-[22px] font-semibold tabular-nums">{value}</div>
    </Card>
  );
}
