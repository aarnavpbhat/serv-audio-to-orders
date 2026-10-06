"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { micProblem, startCapture, type Capture } from "@/lib/sim-capture";
import { cn } from "@/lib/utils";

export type TesterMode = "both" | "robot" | "two";

export interface LabSettings {
  testerMode: TesterMode;
  input: "mic" | "text";
  micOk: boolean;
}

export const MODES: { value: TesterMode; title: string; body: string }[] = [
  { value: "both", title: "Just me, both parts", body: "You read every line. The script shows whose turn it is." },
  { value: "robot", title: "Just me, robot crew", body: "The laptop speaks the crew's lines out loud; you answer as the customer. Turn the volume up so the mic hears it." },
  { value: "two", title: "Two people", body: "One plays the crew, one the customer. Sit side by side about an arm's length from the laptop and talk at a normal volume." },
];

/** A level meter and "Say something": green once speech is heard. Fixes permission and device problems before a test. */
function MicCheck({ echoCancellation, onOk }: { echoCancellation: boolean; onOk: () => void }) {
  const [db, setDb] = useState(-120);
  const [state, setState] = useState<"idle" | "listening" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const loudSince = useRef<number | null>(null);
  useEffect(() => () => capture.current?.stop(), []);
  async function check(): Promise<void> {
    setError(null);
    setState("listening");
    try {
      capture.current = await startCapture({
        echoCancellation,
        onFrame: (_pcm, level) => {
          setDb(level);
          const now = Date.now();
          if (level > -30) loudSince.current ??= now;
          else loudSince.current = null;
          if (loudSince.current !== null && now - loudSince.current > 300) {
            capture.current?.stop();
            capture.current = null;
            setState("ok");
            onOk();
          }
        },
      });
    } catch (e) {
      setState("error");
      setError(micProblem(e));
    }
  }
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={state === "ok" ? "outline" : "default"} onClick={() => void check()} disabled={state === "listening"}>
          {state === "ok" ? "Check again" : "Check microphone"}
        </Button>
        <span className="h-2 w-48 overflow-hidden rounded-full bg-muted" aria-label="Microphone level">
          <span className={cn("block h-full rounded-full", state === "ok" ? "bg-emerald-500" : "bg-brand")} style={{ width: `${state === "ok" ? 100 : pct}%` }} />
        </span>
        <span className={cn("text-[13px]", state === "ok" ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>
          {state === "idle" && "Press the button, then say something."}
          {state === "listening" && "Say something..."}
          {state === "ok" && "Speech detected. The microphone works."}
        </span>
      </div>
      {error && <p className="text-[13px] font-medium text-destructive">{error}</p>}
    </div>
  );
}

export function Setup({ settings, deepgram, onChange, onContinue }: { settings: LabSettings; deepgram: boolean; onChange: (s: LabSettings) => void; onContinue: () => void }) {
  const text = settings.input === "text" || !deepgram;
  return (
    <div className="space-y-6">
      <Card className="gap-4 px-5 py-4 text-[13px]">
        <div>
          <h2 className="section-title">1. Microphone</h2>
          <p className="text-muted-foreground">Speech is transcribed by Deepgram live, which uses credit (a test is about a minute).</p>
        </div>
        {deepgram ? (
          <MicCheck echoCancellation={settings.testerMode !== "robot"} onOk={() => onChange({ ...settings, micOk: true })} />
        ) : (
          <p className="text-muted-foreground">No Deepgram key is set, so tests use typed lines (free).</p>
        )}
      </Card>

      <Card className="gap-4 px-5 py-4 text-[13px]">
        <h2 className="section-title">2. Who is testing</h2>
        <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Who is testing">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={settings.testerMode === m.value}
              onClick={() => onChange({ ...settings, testerMode: m.value })}
              className={cn("rounded-lg border p-3 text-left transition", settings.testerMode === m.value ? "border-brand bg-brand-soft" : "border-line hover:bg-muted")}
            >
              <div className="font-semibold">{m.title}</div>
              <div className="mt-1 text-muted-foreground">{m.body}</div>
            </button>
          ))}
        </div>
      </Card>

      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
        <label className="mt-2 flex items-center gap-2">
          <input type="checkbox" checked={text} disabled={!deepgram} onChange={(e) => onChange({ ...settings, input: e.target.checked ? "text" : "mic" })} aria-label="Type instead of speaking" />
          Type instead of speaking (free, no Deepgram): each line is sent as text when you press Next.
        </label>
      </details>

      <Button size="lg" disabled={!text && !settings.micOk} onClick={onContinue} title={!text && !settings.micOk ? "Check the microphone first" : undefined}>
        Continue to the tests
      </Button>
    </div>
  );
}
