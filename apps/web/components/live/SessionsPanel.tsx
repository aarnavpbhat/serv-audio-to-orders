"use client";

import { useEffect, useState } from "react";
import { SectionHeader } from "../SectionHeader";
import { StopButtons } from "./StopButtons";
import { useSessions } from "./use-sessions";

const since = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/** Every live session, with End and Discard per row (dev routes only; hidden otherwise). */
export function SessionsPanel() {
  const { available, reachable, sessions, stop } = useSessions();
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!available) return null;
  return (
    <section>
      <SectionHeader title="Sessions" details={reachable ? "Live streams on the feed service. End sends the open conversation; Discard drops it." : "The feed service is not reachable, so no sessions are listed."} />
      {note && <p className="mb-2 text-[12.5px] font-medium text-destructive">{note}</p>}
      {reachable && sessions.length === 0 && <p className="text-[13px] text-muted-foreground">No live sessions.</p>}
      <div className="tracks text-[13px]">
        {sessions.map((s) => (
          <div key={s.sessionId} data-session={s.sessionId} className="grid grid-cols-[minmax(0,1fr)_110px_110px_110px_auto] items-center gap-3 px-2 py-1.5">
            <span className="min-w-0 truncate">
              <span className="font-medium">
                {s.storeId} / {s.laneId}
              </span>{" "}
              <span className="font-mono text-[11px] text-muted-foreground">{s.sessionId}</span>
            </span>
            <span className="text-muted-foreground">{s.open ? s.sourceType.replace(/_/g, " ") : "reconnecting"}</span>
            <span className="tabular-nums text-muted-foreground">{since(s.openedAt, now)}</span>
            <span className="tabular-nums text-muted-foreground">{s.audioMinutes.toFixed(2)} min audio</span>
            <StopButtons size="sm" onStop={async (mode) => setNote(await stop(s.sessionId, mode))} />
          </div>
        ))}
      </div>
    </section>
  );
}
