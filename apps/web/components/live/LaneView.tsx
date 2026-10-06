"use client";

import type { TrackerDecision } from "@serv/pipeline";
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { deliveryFor, remainingMs, type LaneState, type LiveUtterance } from "@/lib/live";
import { Artwork, palette } from "../Artwork";
import { Badge } from "../Badge";
import { Equalizer } from "../Icons";
import { OrderCard } from "../run/OrderPanel";

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });

/** Re-render on a short interval so timers count down. */
function useNow(ms = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * One lane, live: connection, rolling transcript with interim text, the
 * tracker's state and timers, the open order building, close decisions and
 * the orders sent. The simulator reuses it.
 */
export function LaneView({ lane, name }: { lane: LaneState; name: (id: string | null) => string }) {
  return (
    <div className="space-y-5">
      <LaneHeader lane={lane} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <LiveTranscript lane={lane} />
        <div className="space-y-5">
          <TrackerCard lane={lane} />
          <DraftCard lane={lane} />
          <Decisions decisions={lane.decisions} />
        </div>
      </div>
      <Orders lane={lane} name={name} />
    </div>
  );
}

function LaneHeader({ lane }: { lane: LaneState }) {
  const s = lane.session;
  return (
    <header className="flex items-center gap-4">
      <Artwork seed={lane.key} label={lane.laneId} size="md" className="w-20!" />
      <div className="min-w-0 flex-1">
        <h1 className="title-xl truncate">
          {lane.storeId} <span className="text-muted-foreground">/</span> {lane.laneId}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
          <span className={cn("flex items-center gap-1.5 font-medium", lane.connected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
            <span className={cn("size-2 rounded-full", lane.connected ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/40")} />
            {lane.connected ? "Connected" : "Not connected"}
          </span>
          {s && (
            <span>
              {s.sourceType === "file_replay" ? "replay" : (s.sourceType ?? "stream")} · {s.codec ?? "?"} · {s.channels === 2 ? "stereo" : "mono"} · since {clock(s.since)}
            </span>
          )}
          <span>{lane.audioMinutes.toFixed(2)} min streamed</span>
          <span className="font-mono text-[11px]">{s?.id}</span>
        </div>
      </div>
    </header>
  );
}

type Line = { kind: "utt"; at: number; u: LiveUtterance } | { kind: "mark"; at: number; text: string; tone: "open" | "close" | "event" };

/** Decisions and vehicle events shown between transcript lines. */
function marks(lane: LaneState): Line[] {
  const out: Line[] = [];
  for (const d of lane.decisions) {
    if (d.from === "IDLE" && d.to === "ACTIVE") out.push({ kind: "mark", at: Date.parse(d.at), text: `${d.conversationId ?? "conversation"} opened · ${d.trigger.replace(/_/g, " ")}`, tone: "open" });
    else if (d.to === "FINALIZED") out.push({ kind: "mark", at: Date.parse(d.at), text: `${d.conversationId ?? "conversation"} finalized · ${d.trigger.replace(/_/g, " ")}`, tone: "close" });
    else if (d.from === "FINALIZED" && d.to === "ACTIVE") out.push({ kind: "mark", at: Date.parse(d.at), text: `${d.conversationId ?? "conversation"} reopened · ${d.trigger.replace(/_/g, " ")}`, tone: "open" });
  }
  // Events a decision already names (the trigger) are not repeated.
  const named = (e: { event: string; at: string }) => lane.decisions.some((d) => d.trigger === e.event && Math.abs(Date.parse(d.at) - Date.parse(e.at)) < 1500);
  for (const e of lane.events) if (!named(e)) out.push({ kind: "mark", at: Date.parse(e.at), text: e.event.replace(/_/g, " "), tone: "event" });
  return out;
}

/** Apple Music lyrics, live: the customer on the left, the crew on the right, the newest line bright. */
function LiveTranscript({ lane }: { lane: LaneState }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lines: Line[] = [...lane.utterances.map((u) => ({ kind: "utt" as const, at: Date.parse(u.start_utc), u })), ...marks(lane)].sort((a, b) => a.at - b.at);
  const last = lane.utterances.at(-1)?.id;
  const [a, b] = palette(lane.key);

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines.length, lane.interim]);

  return (
    <section className="relative overflow-hidden rounded-xl text-white" style={{ background: `linear-gradient(160deg, ${a}, ${b})` }}>
      <div className="absolute inset-0 bg-black/45" />
      <div className="relative flex items-center justify-between px-5 pb-2 pt-4">
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          Transcript {lane.connected && <Equalizer className="text-white/80" />}
        </h2>
        <span className="text-[11px] text-white/60">{lane.utterances.length} lines</span>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="no-scrollbar relative h-[520px] overflow-y-auto px-3 pb-6 pt-2"
      >
        {lines.length === 0 && !lane.interim && <p className="px-3 py-10 text-center text-[13px] text-white/55">Waiting for speech.</p>}
        {lines.map((l, i) =>
          l.kind === "mark" ? (
            <div
              key={`m${i}`}
              className={cn(
                "mx-2 my-3 flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-wider",
                l.tone === "open" ? "text-white/70" : l.tone === "close" ? "text-emerald-200" : "text-amber-200/80",
              )}
            >
              <span className="h-px flex-1 bg-white/20" />
              {l.text}
              <span className="h-px flex-1 bg-white/20" />
            </div>
          ) : (
            <Utterance key={l.u.id} u={l.u} bright={l.u.id === last} />
          ),
        )}
        {lane.interim && <div className="px-3 py-1.5 text-[17px] font-semibold italic text-white/45">{lane.interim}</div>}
      </div>
    </section>
  );
}

function Utterance({ u, bright }: { u: LiveUtterance; bright: boolean }) {
  const crew = u.speaker === "crew";
  return (
    <div className={cn("flex flex-col rounded-lg px-3 py-1.5 transition-all duration-300", crew ? "items-end pl-14 text-right" : "items-start pr-14 text-left")}>
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-white/55">
        {u.speaker}
        {u.speaker_guessed ? "?" : ""} · {clock(u.start_utc)}
      </span>
      <span className={cn("text-[19px] font-bold leading-snug", bright ? "text-white" : "text-white/70")}>{u.text}</span>
    </div>
  );
}

const STATE_TONE: Record<string, string> = {
  IDLE: "bg-muted text-muted-foreground",
  ACTIVE: "bg-sky-500/12 text-sky-700 dark:text-sky-400",
  CLOSING: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  FINALIZED: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
};

const TIMER_LABEL: Record<string, string> = {
  settle: "Close settles",
  idle: "Idle timeout",
  grace: "Reconnect grace",
  reopen: "Reopen window",
  max: "Length cap",
};

function TrackerCard({ lane }: { lane: LaneState }) {
  const now = useNow();
  const st = lane.status;
  const timers = Object.entries(st?.timers ?? {}).filter(([, v]) => v);
  return (
    <section>
      <h2 className="section-title mb-2">Conversation Tracker</h2>
      <Card className="gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={cn("rounded-md px-2 py-0.5 text-[13px] font-semibold tracking-wide", STATE_TONE[st?.state ?? "IDLE"])}>{st?.state ?? "IDLE"}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{st?.conversationId ?? "no conversation"}</span>
        </div>
        {timers.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">No timers running.</p>
        ) : (
          <div className="space-y-1.5">
            {timers.map(([k, v]) => {
              const left = remainingMs(lane, v, now);
              const s = left === null ? null : Math.max(0, left / 1000);
              return (
                <div key={k} className="flex items-center gap-3 text-[13px]">
                  <span className="w-32 shrink-0 text-muted-foreground">{TIMER_LABEL[k] ?? k}</span>
                  <span className={cn("tabular-nums font-medium", s !== null && s < 5 && "text-amber-600 dark:text-amber-400")}>{s === null ? "-" : lane.connected ? `${s.toFixed(1)} s` : "paused"}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </section>
  );
}

function DraftCard({ lane }: { lane: LaneState }) {
  const open = lane.draft.conversationId !== null;
  return (
    <section>
      <h2 className="section-title mb-2 flex items-center gap-2">
        Open Order {open && <Equalizer className="text-brand" />}
      </h2>
      <Card className="gap-1.5 px-4 py-3 text-[13px]">
        {!open && <p className="text-muted-foreground">No open conversation.</p>}
        {open && lane.draft.lines.length === 0 && <p className="text-muted-foreground">Listening for items.</p>}
        {lane.draft.lines.map((l, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-6 text-right tabular-nums text-muted-foreground">{l.quantity}×</span>
            <span className="font-medium">{l.name}</span>
            {l.size && <span className="text-muted-foreground">{l.size}</span>}
          </div>
        ))}
        {open && <p className="pt-1 text-[11.5px] text-muted-foreground">Keyword preview. The order is built by the extractor when the conversation closes.</p>}
      </Card>
    </section>
  );
}

function Decisions({ decisions }: { decisions: TrackerDecision[] }) {
  const recent = decisions.slice(-8).reverse();
  return (
    <section>
      <h2 className="section-title mb-2">Decisions</h2>
      <Card className="gap-0 py-1 text-[12.5px]">
        {recent.length === 0 && <p className="px-4 py-2 text-muted-foreground">None yet.</p>}
        {recent.map((d, i) => (
          <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-line px-4 py-1.5 [&+&]:border-t">
            <span className="tabular-nums text-muted-foreground">{clock(d.at)}</span>
            <span className="font-medium">
              {d.from} → {d.to}
            </span>
            <span>{d.trigger.replace(/_/g, " ")}</span>
            {d.signals.map((s) => (
              <span key={s} className="rounded bg-muted px-1.5 font-mono text-[10.5px] text-muted-foreground">
                {s}
              </span>
            ))}
          </div>
        ))}
      </Card>
    </section>
  );
}

function Orders({ lane, name }: { lane: LaneState; name: (id: string | null) => string }) {
  return (
    <section>
      <h2 className="section-title mb-2">Orders</h2>
      {lane.orders.length === 0 && <p className="text-[13px] text-muted-foreground">No orders on this lane yet.</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {lane.orders.map((o) => {
          const d = deliveryFor(lane, o.order_id, o.order_version);
          return (
            <Card key={o.order_id} className="gap-2 py-3">
              <div className="flex items-center gap-2 px-4 text-[12px] text-muted-foreground">
                <span>
                  {clock(o.times.started_at)} to {clock(o.times.ended_at)}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  webhook {d ? <Badge value={d.status} label={`${d.status} · ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}${d.code ? ` · ${d.code}` : ""}`} /> : <Badge value="pending" label="sending" />}
                </span>
              </div>
              <div className="px-2">
                <OrderCard order={o} phase="final" name={name} />
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
