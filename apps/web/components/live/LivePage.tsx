"use client";

import { Catalog } from "@serv/pipeline/menu/catalog";
import { useCallback, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { LaneState } from "@/lib/live";
import { Artwork } from "../Artwork";
import { LaneView } from "./LaneView";
import { SessionsPanel } from "./SessionsPanel";
import { useLiveFeed } from "./use-live-feed";

/** Every lane the live service (or a replay) has reported, newest activity first; one shown at a time. */
export function LivePage({ menu }: { menu: unknown }) {
  const { lanes, connected } = useLiveFeed();
  const catalog = useMemo(() => Catalog.fromJson(menu), [menu]);
  const name = useCallback((cid: string | null) => (cid ? catalog.name(cid) : ""), [catalog]);
  const list = Object.values(lanes).sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastAt - a.lastAt);
  const [picked, setPicked] = useState<string | null>(null);
  const lane = (picked ? lanes[picked] : undefined) ?? list[0];

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-8 pb-16 pt-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("mr-2 flex items-center gap-1.5 text-[12px]", connected ? "text-muted-foreground" : "text-rose-600 dark:text-rose-400")}>
          <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-rose-500")} />
          {connected ? "Feed connected" : "Feed reconnecting"}
        </span>
        {list.map((l) => (
          <LaneChip key={l.key} lane={l} active={l.key === lane?.key} onClick={() => setPicked(l.key)} />
        ))}
      </div>
      <SessionsPanel />
      {lane ? <LaneView lane={lane} name={name} /> : <Empty />}
    </div>
  );
}

function LaneChip({ lane, active, onClick }: { lane: LaneState; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex items-center gap-2 rounded-lg px-2 py-1 text-[12.5px]", active ? "bg-fill-strong font-medium" : "hover:bg-muted")}>
      <Artwork seed={lane.key} size="xs" />
      {lane.storeId} / {lane.laneId}
      <span className={cn("size-1.5 rounded-full", lane.connected ? "bg-emerald-500" : "bg-muted-foreground/40")} />
    </button>
  );
}

function Empty() {
  return (
    <div className="py-16 text-center">
      <h1 className="title-xl">No live lanes yet</h1>
      <p className="mx-auto mt-2 max-w-md text-[13px] text-muted-foreground">
        Start the live service with <code className="font-mono">pnpm feed serve</code> and connect a base station, or replay a recording with{" "}
        <code className="font-mono">pnpm feed replay lane_stream_a --speed 1</code>. Lanes appear here as they report.
      </p>
    </div>
  );
}
