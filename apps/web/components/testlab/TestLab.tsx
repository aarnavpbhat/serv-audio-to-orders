"use client";

import type { Scenario } from "@serv/pipeline";
import { Catalog } from "@serv/pipeline/menu/catalog";
import Link from "next/link";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Card } from "@/components/ui/Card";
import type { ScoreResponse } from "@/lib/testlab";
import { cn } from "@/lib/utils";
import { FreePlayAnswer, type AnswerOrder } from "./FreePlayAnswer";
import { RunScreen } from "./RunScreen";
import { Scorecard } from "./Scorecard";
import { MODES, Setup, type LabSettings } from "./Setup";

const KEY = "serv-testlab";
const STORE = "store_testlab";
const DEFAULTS: LabSettings = { testerMode: "both", input: "mic", micOk: false };

const noSubscribe = () => () => {};
function readSettings(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

type Phase =
  | { kind: "setup" }
  | { kind: "pick" }
  | { kind: "run"; scenario: Scenario | null; laneId: string; attempt: number }
  | { kind: "answer"; laneId: string; since: number; until: number }
  | { kind: "scoring"; scenario: Scenario | null }
  | { kind: "score"; scenario: Scenario | null; result: ScoreResponse; run: { storeId: string; laneId: string; since: number; until: number } };

/** A fresh lane per run, so a run's orders are exactly the ones on its lane. */
function runPhase(scenario: Scenario | null): Phase {
  const now = Date.now();
  return { kind: "run", scenario, laneId: `tl_${scenario ? scenario.number : "free"}_${now.toString(36)}`, attempt: now };
}

/**
 * Test Lab: Setup, pick a test, run it with an on-screen script, then a scorecard
 * saying whether the system got it right and, if not, which part failed.
 */
export function TestLab({ scenarios, menu, deepgram }: { scenarios: Scenario[]; menu: unknown; deepgram: boolean }) {
  const catalog = useMemo(() => Catalog.fromJson(menu), [menu]);
  const name = useCallback((cid: string | null) => (cid && catalog.has(cid) ? catalog.name(cid) : (cid ?? "")), [catalog]);
  // Setup is remembered in this browser (read after hydration).
  const stored = useSyncExternalStore(noSubscribe, readSettings, () => "");
  const [edited, setEdited] = useState<LabSettings | null>(null);
  const settings: LabSettings = edited ?? (stored ? { ...DEFAULTS, ...(JSON.parse(stored) as Partial<LabSettings>) } : DEFAULTS);
  const effective: LabSettings = deepgram ? settings : { ...settings, input: "text" };
  const ready = effective.input === "text" || effective.micOk;
  const [phase, setPhase] = useState<Phase | null>(null);
  const current: Phase = phase ?? (stored && ready ? { kind: "pick" } : { kind: "setup" });
  const [error, setError] = useState<string | null>(null);

  const save = (s: LabSettings) => {
    setEdited(s);
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // not remembered; still used now
    }
  };

  const run = (scenario: Scenario | null) => setPhase(runPhase(scenario));

  async function score(scenario: Scenario | null, laneId: string, since: number, until: number, expected?: AnswerOrder[]): Promise<void> {
    setPhase({ kind: "scoring", scenario });
    setError(null);
    const res = await fetch("/api/testlab/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(scenario ? { scenarioId: scenario.id } : { expected }), storeId: STORE, laneId, since, testerMode: effective.testerMode, input: effective.input }),
    });
    const body = (await res.json().catch(() => ({}))) as ScoreResponse & { error?: { message?: string } };
    if (!res.ok) {
      setError(body.error?.message ?? `Scoring failed (${res.status})`);
      setPhase({ kind: "pick" });
      return;
    }
    setPhase({ kind: "score", scenario, result: body, run: { storeId: STORE, laneId, since, until } });
  }

  const next = (s: Scenario | null) => scenarios.find((x) => s && x.number === s.number + 1) ?? null;
  const mode = MODES.find((m) => m.value === effective.testerMode);

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-8 pb-16 pt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="title-xl">Test Lab</h1>
          <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">Pick a test, follow the script on screen, and get a scorecard: did the system get the order right, and if not, which part failed.</p>
        </div>
        <nav className="flex items-center gap-4 text-[13px]">
          {current.kind !== "setup" && (
            <button type="button" className="text-brand hover:underline" onClick={() => setPhase({ kind: "setup" })}>
              Setup ({mode?.title.toLowerCase()}, {effective.input === "text" ? "typing" : "microphone"})
            </button>
          )}
          <Link href="/testlab/history" className="text-brand hover:underline">
            Results history
          </Link>
        </nav>
      </header>

      {error && <p className="text-[13px] font-medium text-destructive">{error}</p>}

      {current.kind === "setup" && <Setup settings={effective} deepgram={deepgram} onChange={save} onContinue={() => setPhase({ kind: "pick" })} />}

      {current.kind === "pick" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {scenarios.map((s) => (
            <button key={s.id} type="button" onClick={() => run(s)} className="rounded-lg text-left" aria-label={`Test ${s.number}: ${s.title}`}>
              <Card className="h-full gap-1.5 px-4 py-3 text-[13px] transition hover:bg-muted">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">
                    {s.number}. {s.title}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">about {s.minutes} min</span>
                </div>
                <div className="text-muted-foreground">{s.checks}</div>
              </Card>
            </button>
          ))}
          <button type="button" onClick={() => run(null)} className="rounded-lg text-left" aria-label="Free play">
            <Card className="h-full gap-1.5 border-dashed px-4 py-3 text-[13px] transition hover:bg-muted">
              <span className="font-semibold">Free play</span>
              <div className="text-muted-foreground">No script: order anything. Afterwards you say what was actually ordered, and the run is scored against that.</div>
            </Card>
          </button>
        </div>
      )}

      {current.kind === "run" && (
        <div className="space-y-3">
          <div className="text-[15px] font-semibold">{current.scenario ? `${current.scenario.number}. ${current.scenario.title}` : "Free play"}</div>
          <RunScreen
            key={current.attempt}
            scenario={current.scenario}
            settings={effective}
            storeId={STORE}
            laneId={current.laneId}
            name={name}
            onDiscarded={() => setPhase({ kind: "pick" })}
            onFinished={(since) => {
              const until = Date.now();
              if (current.scenario) void score(current.scenario, current.laneId, since, until);
              else setPhase({ kind: "answer", laneId: current.laneId, since, until });
            }}
          />
        </div>
      )}

      {current.kind === "answer" && <FreePlayAnswer catalog={catalog} onSkip={() => setPhase({ kind: "pick" })} onScore={(orders) => void score(null, current.laneId, current.since, current.until, orders)} />}

      {current.kind === "scoring" && <p className={cn("text-[15px] text-muted-foreground")}>Scoring the run against the script...</p>}

      {current.kind === "score" && (
        <Scorecard
          result={current.result}
          scenario={current.scenario}
          hasNext={!!next(current.scenario)}
          name={name}
          run={current.run}
          onRetry={() => run(current.scenario)}
          onNext={() => run(next(current.scenario))}
        />
      )}

      {current.kind === "pick" && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
          <p className="mt-2 text-muted-foreground">
            The <Link href="/simulator" className="text-brand hover:underline">manual simulator</Link> has every control (vehicle events, pauses, faults, codecs, noise) without a script.
          </p>
        </details>
      )}
    </div>
  );
}
