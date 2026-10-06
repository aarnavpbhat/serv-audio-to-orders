"use client";

import { useCallback, useEffect, useState } from "react";
import type { FeedSession, StopMode } from "@/lib/feed";

/** Live sessions from the feed service (dev routes); polled every 2 s. */
export function useSessions(): {
  available: boolean;
  reachable: boolean;
  sessions: FeedSession[];
  stop: (sessionId: string, mode: StopMode) => Promise<string | null>;
  refresh: () => Promise<FeedSession[]>;
} {
  const [state, setState] = useState<{ available: boolean; reachable: boolean; sessions: FeedSession[] }>({ available: false, reachable: false, sessions: [] });
  const refresh = useCallback(async (): Promise<FeedSession[]> => {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (!res.ok) {
        setState({ available: false, reachable: false, sessions: [] });
        return [];
      }
      const body = (await res.json()) as { reachable: boolean; sessions: FeedSession[] };
      setState({ available: true, ...body });
      return body.sessions;
    } catch {
      return [];
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 2000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);
  /** Returns an error message for the user, or null when it stopped (or was already stopped). */
  const stop = useCallback(
    async (sessionId: string, mode: StopMode): Promise<string | null> => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
        await refresh();
        if (res.status === 503) return "The feed service is not reachable. Start it with ENABLE_DEV_ROUTES=true pnpm feed serve.";
        return res.ok ? null : `Could not stop the session (status ${res.status}).`;
      } catch {
        return "Cannot reach the web app.";
      }
    },
    [refresh],
  );
  return { ...state, stop, refresh };
}
