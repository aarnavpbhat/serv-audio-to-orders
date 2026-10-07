"use client";

import type { Scenario, ScenarioAction } from "@serv/pipeline";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { emptyLane } from "@/lib/live";
import { cn } from "@/lib/utils";
import { Badge } from "../Badge";
import { StopButtons } from "../live/StopButtons";
import { useLiveFeed } from "../live/use-live-feed";
import type { LabSettings } from "./Setup";
import { useTestStream } from "./use-test-stream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tracker state in plain words. */
const STATUS: Record<string, string> = { IDLE: "Waiting for a car", ACTIVE: "Ordering", CLOSING: "Wrapping up", FINALIZED: "Order sent" };

/** Actions at a point in the script (mirrors the pipeline's actionsAt, kept here so the page needs no server code). */
function actionsAt(s: Scenario, point: "start" | "end" | number): ScenarioAction[] {
  return s.actions.filter((a) => {
    if (point === "start") return a.at === "start";
    if (point === "end") return a.at === "end" || (typeof a.at === "object" && a.at.after_line === s.lines.length);
    return typeof a.at === "object" && a.at.after_line === point && point !== s.lines.length;
  });
}

/**
 * The run screen: a teleprompter for the scenario's lines (or none in free play),
 * the actions the app performs itself (with a banner), the live transcript and
 * order, and End or Discard always in reach. Manual controls are in Advanced.
 */
export function RunScreen({
  scenario,
  settings,
  storeId,
  laneId,
  name,
  onFinished,
  onDiscarded,
}: {
  scenario: Scenario | null;
  settings: LabSettings;
  storeId: string;
  laneId: string;
  name: (id: string | null) => string;
  onFinished: (since: number) => void;
  onDiscarded: () => void;
}) {
  const { lanes } = useLiveFeed();
  const lane = lanes[`${storeId}:${laneId}`] ?? emptyLane(storeId, laneId);
  const stream = useTestStream(storeId, laneId);
  const [since, setSince] = useState<number | null>(null);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"ready" | "starting" | "reading" | "acting" | "waiting" | "done">("ready");
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const linesSeen = useRef(0);
  const lines = scenario?.lines ?? [];
  const line = lines[index];
  const text = settings.input === "text";
  const robot = settings.testerMode === "robot" && !text;
  const finishing = useRef(false);
  const linkOpen = useRef(false);
  useEffect(() => {
    linkOpen.current = stream.link.state === "open";
  }, [stream.link.state]);

  const act = useCallback(
    async (point: "start" | "end" | number) => {
      if (!scenario) return;
      for (const a of actionsAt(scenario, point)) {
        if (a.do === "car_arrived") {
          setBanner("A car arrived at the speaker post.");
          stream.event("vehicle_arrived");
          await sleep(1200);
        } else if (a.do === "car_left") {
          setBanner("The car drove away from the post.");
          stream.event("vehicle_departed");
          await sleep(1200);
        } else if (a.seconds) {
          stream.drop(a.seconds);
          for (let left = a.seconds; left > 0; left--) {
            setBanner(`Simulating a dropped connection, reconnecting in ${left} s.`);
            await sleep(1000);
          }
          setBanner("Reconnecting...");
          await sleep(2500);
        } else {
          stream.drop(null);
          setBanner("Simulating a lost connection. The order is sent when the reconnect grace period runs out (3 minutes by default).");
          await sleep(1000);
        }
      }
      setBanner(null);
    },
    [scenario, stream],
  );

  /** The current line was read (or skipped on purpose): perform what follows it, then show the next one. */
  const advance = useCallback(async (skip = false) => {
    if (!line || phase !== "reading") return;
    if (text && !skip) stream.say(line.role, line.text);
    const done = index + 1;
    setPhase("acting");
    await act(done === lines.length ? "end" : done);
    linesSeen.current = lane.utterances.length;
    setIndex(done);
    setPhase(done === lines.length ? "waiting" : "reading");
  }, [act, index, lane.utterances.length, line, lines.length, phase, stream, text]);

  async function begin(): Promise<void> {
    setPhase("starting");
    setError(null);
    const at = Date.now();
    setSince(at);
    const err = await stream.start(settings.input, settings.testerMode !== "robot");
    if (err) {
      setError(err);
      setPhase("ready");
      await stream.finish("discard");
      return;
    }
    // Wait for the connection before the first action.
    for (let i = 0; i < 100 && !linkOpen.current; i++) await sleep(100);
    await act("start");
    linesSeen.current = lane.utterances.length;
    setPhase("reading");
  }

  const finish = useCallback(
    async (mode: "end" | "discard") => {
      if (finishing.current) return;
      finishing.current = true;
      setPhase("done");
      setBanner(mode === "end" ? "Scoring the run..." : null);
      const err = await stream.finish(mode);
      if (err) setError(err);
      if (mode === "discard") onDiscarded();
      else if (since !== null) onFinished(since);
    },
    [onDiscarded, onFinished, since, stream],
  );

  // Timers below call the latest advance and finish without restarting on every render
  // (the live feed re-renders this screen many times a second).
  const advanceRef = useRef(advance);
  const finishRef = useRef(finish);
  useEffect(() => {
    advanceRef.current = advance;
    finishRef.current = finish;
  });

  // A late addition waits until the first order was sent (each run has its own lane, so every order is this run's).
  const locked = !!line?.wait_for && lane.orders.length === 0;

  // Mic: the line is done when the transcript finalizes one from the expected speaker.
  useEffect(() => {
    if (phase !== "reading" || text || !line || locked) return;
    const fresh = lane.utterances.slice(linesSeen.current);
    if (fresh.some((u) => u.speaker === line.role)) void advance();
  }, [advance, lane.utterances, line, locked, phase, text]);

  // Robot crew: the laptop speaks the crew's lines, then moves on.
  useEffect(() => {
    if (!robot || phase !== "reading" || !line || line.role !== "crew" || locked) return;
    if (typeof speechSynthesis === "undefined") return;
    const u = new SpeechSynthesisUtterance(line.text);
    u.onend = () => setTimeout(() => void advanceRef.current(), 1500);
    speechSynthesis.speak(u);
    return () => speechSynthesis.cancel();
  }, [line, locked, phase, robot]);

  // Typed lines can play hands-free.
  useEffect(() => {
    if (!autoPlay || phase !== "reading" || locked) return;
    const t = setTimeout(() => void advanceRef.current(), 1200);
    return () => clearTimeout(t);
  }, [autoPlay, locked, phase, index]);

  // Space advances by hand.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      if (!locked) void advance();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [advance, locked]);

  // After the script: wait for the expected orders (and versions), then end the session and score.
  const want = scenario?.expected.orders ?? [];
  const enough = lane.orders.length >= want.length && want.every((w, i) => (lane.orders[lane.orders.length - 1 - i]?.order_version ?? 0) >= (w.lane_version ?? 1));
  const lost = !!scenario?.actions.some((a) => a.do === "drop" && !a.seconds);
  useEffect(() => {
    if (phase !== "waiting" || !scenario) return;
    const t = setTimeout(() => void finishRef.current("end"), enough ? 2500 : lost ? 240_000 : 45_000);
    return () => clearTimeout(t);
  }, [enough, lost, phase, scenario]);

  const status = lane.status?.state;
  return (
    <div className="space-y-5">
      {banner && (
        <div role="status" className="rounded-lg bg-brand-soft px-4 py-2.5 text-[14px] font-medium text-brand">
          {banner}
        </div>
      )}
      {error && <p className="text-[13px] font-medium text-destructive">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        {phase === "ready" ? (
          <Button size="lg" onClick={() => void begin()}>
            {scenario ? "Start the test" : "Start free play"}
          </Button>
        ) : (
          phase !== "done" && <StopButtons onStop={(mode) => finish(mode)} />
        )}
        <span data-testid="status-chip" className="rounded-md bg-muted px-2.5 py-1 text-[13px] font-semibold">
          {phase === "ready" ? "Not started" : phase === "starting" ? "Connecting" : status ? (STATUS[status] ?? status) : "Waiting for a car"}
        </span>
        {stream.link.state === "open" && <span className="text-[12px] text-muted-foreground">connected</span>}
        {stream.link.note?.tone === "error" && <span className="text-[12px] font-medium text-destructive">{stream.link.note.text}</span>}
        {!text && phase !== "ready" && <span className="text-[12px] text-muted-foreground">{stream.sentS.toFixed(0)} s of audio sent</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card className="gap-4 px-6 py-6">
          {scenario ? (
            <>
              <div className="label text-[10.5px]">
                Line {Math.min(index + 1, lines.length)} of {lines.length}
              </div>
              {line ? (
                <div data-testid="teleprompter">
                  <div className={cn("text-[13px] font-bold uppercase tracking-[0.08em]", line.role === "crew" ? "text-crew" : "text-customer")}>{line.role === "crew" ? (robot ? "CREW (the laptop says it)" : "CREW") : "CUSTOMER"}</div>
                  <div className={cn("mt-2 text-[30px] font-semibold leading-tight", locked && "opacity-40")}>{line.text}</div>
                  {locked && <div className="mt-2 text-[13px] text-muted-foreground">Wait until the status says Order sent, then read this line.</div>}
                  {lines[index + 1] && (
                    <div className="mt-6 text-[15px] text-muted-foreground">
                      Next, {lines[index + 1]?.role}: {lines[index + 1]?.text}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[18px] text-muted-foreground">{phase === "waiting" ? "That's the script. Waiting for the order to be sent..." : "Done."}</div>
              )}
              {phase === "reading" && line && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => void advance()} disabled={locked}>
                    {text ? "Send this line" : "Next (Space)"}
                  </Button>
                  {text && (
                    <Button variant="outline" onClick={() => setAutoPlay(!autoPlay)}>
                      {autoPlay ? "Pause the script" : "Play the script"}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void advance(true)} title="Leave this line out, to see how a wrong run is scored">
                    Skip this line
                  </Button>
                  <span className="text-[12px] text-muted-foreground">{text ? "Each line is sent as typed text." : "The script moves on when it hears the line; Space moves on by hand."}</span>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3">
              <div className="text-[18px]">Free play: order whatever you like, as crew and customer.</div>
              <p className="text-[13px] text-muted-foreground">When you are done, press End session. You will be asked what was actually ordered, so the run can be scored.</p>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="gap-1.5 px-4 py-3 text-[13px]">
            <div className="label text-[10.5px]">Heard so far</div>
            {lane.utterances.slice(-8).map((u) => (
              <div key={u.id} className="flex gap-2">
                <span className={cn("w-20 shrink-0 text-[11px] font-semibold uppercase", u.speaker === "crew" ? "text-crew" : "text-customer")}>{u.speaker}</span>
                <span>{u.text}</span>
              </div>
            ))}
            {lane.interim && <div className="italic text-muted-foreground">{lane.interim}</div>}
            {!lane.utterances.length && !lane.interim && <div className="text-muted-foreground">Nothing yet.</div>}
          </Card>
          <Card className="gap-1.5 px-4 py-3 text-[13px]">
            <div className="label text-[10.5px]">The order</div>
            {lane.draft.lines.map((l, i) => (
              <div key={i}>
                {l.quantity} {l.size ? `${l.size} ` : ""}
                {l.name}
              </div>
            ))}
            {lane.orders.map((o) => (
              <div key={o.order_id} className="flex flex-wrap items-center gap-2">
                <Badge value={o.status} />
                <span>{o.items.map((i) => `${i.quantity} ${name(i.catalog_id)}`).join(", ") || "No items"}</span>
                <span className="text-muted-foreground">v{o.order_version} sent</span>
              </div>
            ))}
            {!lane.draft.lines.length && !lane.orders.length && <div className="text-muted-foreground">Nothing ordered yet.</div>}
          </Card>
        </div>
      </div>

      <details className="text-[13px]">
        <summary className="cursor-pointer text-muted-foreground">Advanced: manual controls</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => stream.event("vehicle_arrived")}>
            Car arrived
          </Button>
          <Button variant="outline" size="sm" onClick={() => stream.event("vehicle_departed")}>
            Car left
          </Button>
          <Button variant="outline" size="sm" onClick={() => stream.event("stream_paused")}>
            Pause stream
          </Button>
          <Button variant="outline" size="sm" onClick={() => stream.event("stream_resumed")}>
            Resume stream
          </Button>
          <Button variant="outline" size="sm" onClick={() => stream.drop(8)}>
            Drop connection for 8 s
          </Button>
        </div>
      </details>
    </div>
  );
}
