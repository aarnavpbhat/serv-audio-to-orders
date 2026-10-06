"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { micProblem, startCapture, type Capture } from "@/lib/sim-capture";
import { SimLink, type LinkNote, type LinkState } from "@/lib/sim-link";
import { useSessions } from "../live/use-sessions";

export type Input = "mic" | "text";

/**
 * One Test Lab stream: the simulator's connection to the real endpoint, driven by
 * the run screen instead of buttons. Drops are timed (an outage of N seconds, or
 * for good), and End or Discard settle the server's session before the mic and
 * the link close, so nothing reconnects afterwards.
 */
export function useTestStream(storeId: string, laneId: string) {
  const [link, setLink] = useState<{ state: LinkState; note?: LinkNote }>({ state: "idle" });
  const [levelDb, setLevelDb] = useState(-120);
  const [sentS, setSentS] = useState(0);
  const linkRef = useRef<SimLink | null>(null);
  const capture = useRef<Capture | null>(null);
  const sent = useRef(0);
  const lastMeter = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { sessions, stop: stopSession, refresh } = useSessions();
  const sessionId = useRef<string | null>(null);

  useEffect(() => {
    const mine = sessions.filter((s) => s.storeId === storeId && s.laneId === laneId).at(-1);
    if (mine) sessionId.current = mine.sessionId;
  }, [sessions, storeId, laneId]);

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    capture.current?.stop();
    capture.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /** Connect, then start the mic unless typing. Resolves with an error message, or null when streaming. */
  const start = useCallback(
    async (input: Input, echoCancellation: boolean): Promise<string | null> => {
      sent.current = 0;
      setSentS(0);
      const l = new SimLink({ storeId, laneId, codec: "pcm_s16le", autoReconnect: true, onState: (state, note) => setLink({ state, ...(note ? { note } : {}) }) });
      linkRef.current = l;
      await l.connect();
      if (input === "text") return null;
      try {
        capture.current = await startCapture({
          echoCancellation,
          onFrame: (pcm, db) => {
            const now = Date.now();
            if (now - lastMeter.current > 100) {
              lastMeter.current = now;
              setLevelDb(db);
              setSentS(sent.current / 16_000);
            }
            if (linkRef.current?.open) {
              linkRef.current.sendAudio(pcm);
              sent.current += pcm.length;
            }
          },
        });
        return null;
      } catch (e) {
        return micProblem(e);
      }
    },
    [laneId, storeId],
  );

  const event = useCallback((type: "vehicle_arrived" | "vehicle_departed" | "stream_paused" | "stream_resumed") => linkRef.current?.sendEvent(type), []);
  const say = useCallback((speaker: "crew" | "customer", text: string) => linkRef.current?.sendLine(speaker, text), []);

  /** Drop the connection; reconnect after `seconds`, or never (null). */
  const drop = useCallback((seconds: number | null) => {
    const l = linkRef.current;
    if (!l) return;
    l.autoReconnect = false;
    l.drop();
    if (seconds !== null) {
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        if (linkRef.current === l) void l.connect();
      }, seconds * 1000);
    }
  }, []);

  /** End or Discard on the server (when it knows the session), then close everything here. */
  const finish = useCallback(
    async (mode: "end" | "discard"): Promise<string | null> => {
      if (linkRef.current) linkRef.current.autoReconnect = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const id = sessionId.current ?? (await refresh()).filter((s) => s.storeId === storeId && s.laneId === laneId).at(-1)?.sessionId ?? null;
      const err = id ? await stopSession(id, mode) : null;
      cleanup();
      setLink({ state: "idle" });
      return err;
    },
    [cleanup, laneId, refresh, stopSession, storeId],
  );

  return { link, levelDb, sentS, start, event, say, drop, finish };
}
