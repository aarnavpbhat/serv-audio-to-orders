"use client";

import { useEffect, useRef, useState } from "react";
import { applyRows, type LaneState, type LiveRow } from "@/lib/live";

/** The live_events feed over server-sent events, folded into lane state. Batches rows per animation frame. */
export function useLiveFeed(): { lanes: Record<string, LaneState>; connected: boolean } {
  const [lanes, setLanes] = useState<Record<string, LaneState>>({});
  const [connected, setConnected] = useState(false);
  const queue = useRef<LiveRow[]>([]);

  useEffect(() => {
    const es = new EventSource("/api/live/events");
    let frame = 0;
    const flush = () => {
      frame = 0;
      const rows = queue.current.splice(0);
      if (rows.length) setLanes((prev) => applyRows(prev, rows));
    };
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e: MessageEvent<string>) => {
      queue.current.push(JSON.parse(e.data) as LiveRow);
      frame ||= requestAnimationFrame(flush);
    };
    return () => {
      es.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return { lanes, connected };
}
