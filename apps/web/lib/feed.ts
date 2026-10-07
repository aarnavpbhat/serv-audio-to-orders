/**
 * The web app's line to the feed service's dev routes (localhost only): list
 * live sessions and stop one (E3). The feed service owns the sessions; this
 * only forwards. An unreachable feed service reads as "no sessions".
 */
import { getConfig } from "@serv/config";

export type StopMode = "end" | "discard";

export interface FeedSession {
  sessionId: string;
  storeId: string;
  laneId: string;
  open: boolean;
  sourceType: string;
  openedAt: string;
  audioMinutes: number;
}

/** ws://host:port -> http://host:port (the feed's HTTP routes share its port). */
export function feedHttpUrl(): string {
  return getConfig().ingest.publicUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

export async function listFeedSessions(): Promise<{ reachable: boolean; sessions: FeedSession[] }> {
  try {
    const res = await fetch(`${feedHttpUrl()}/dev/sessions`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: false, sessions: [] };
    return { reachable: true, sessions: ((await res.json()) as { sessions: FeedSession[] }).sessions };
  } catch {
    return { reachable: false, sessions: [] };
  }
}

export async function stopFeedSession(sessionId: string, mode: StopMode): Promise<{ reachable: boolean; stopped: boolean }> {
  try {
    const res = await fetch(`${feedHttpUrl()}/dev/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { reachable: false, stopped: false };
    return { reachable: true, stopped: ((await res.json()) as { stopped: boolean }).stopped };
  } catch {
    return { reachable: false, stopped: false };
  }
}
