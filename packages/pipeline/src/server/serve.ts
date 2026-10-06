/**
 * pnpm feed serve: the live service. HME base stations (or the simulator, or a
 * replay acting as a base station) connect to the WebSocket endpoint; each
 * store_id:lane_id gets a lane with its own streaming transcriber and tracker;
 * finished conversations become orders and webhooks.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Engine } from "../engine";
import type { SourceMessage } from "../input/types";
import { newId } from "../lib/ids";
import { ntpOffsetMs } from "../lib/sntp";
import { liveWriter } from "../lane/live-feed";
import { LaneManager } from "../lane/manager";
import { sttName } from "../lane/types";
import { ScriptStreamingTranscriber } from "../lane/script-transcriber";
import type { LaneSession, LaneUpdate } from "../lane/lane";
import { insertRun, updateRun } from "../store/db";
import { RawCaptureSink } from "../data/raw-sink";
import { IngestServer } from "./ingest-server";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Lane updates for the live UI. */
  onUpdate?: (lane: LaneSession, update: LaneUpdate) => void;
  /** Override ENABLE_DEV_ROUTES (tests and the eval's in-process checks). */
  devRoutes?: boolean;
  /**
   * Keep everything in the data store (default true): raw capture of every
   * message, order audio, Deepgram messages, session events. False for the
   * eval's in-process checks.
   */
  record?: boolean;
  /** Write lane updates to live_events for the web app's live view (default true). */
  liveFeed?: boolean;
  /** Raw capture staging root (default DATA_DIR/staging/raw). */
  stagingRoot?: string;
  log?: (line: Record<string, unknown>) => void;
  /** Skip the NTP offset check (tests). */
  skipClockCheck?: boolean;
  /** Send webhooks (default true). */
  deliver?: boolean;
}

export interface Service {
  server: IngestServer;
  manager: LaneManager;
  stop(): Promise<void>;
}

/** Fixture id -> mono fixture audio (dev only; the id is validated by the server first). */
export function fixtureResolver(fixturesDir: string): (id: string) => string | null {
  const dir = path.join(fixturesDir, "audio");
  return (id) => {
    if (!existsSync(dir)) return null;
    const hit = readdirSync(dir).find((f) => f.startsWith(`${id}.mono.`) && f.endsWith(".mp3"));
    return hit ? path.join(dir, hit) : null;
  };
}

export async function startService(engine: Engine, opts: ServeOptions = {}): Promise<Service> {
  const { cfg, db } = engine;
  const devRoutes = opts.devRoutes ?? cfg.enableDevRoutes;
  const log = opts.log ?? ((l: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ severity: "INFO", ...l })}\n`));

  // Order times use our receive clock, so they are only as right as this machine's clock.
  const offset = opts.skipClockCheck ? null : await ntpOffsetMs();
  log({ event: "clock_offset", ntp_offset_ms: offset, note: offset === null ? "NTP unreachable; check the server runs NTP" : Math.abs(offset) > 1000 ? "clock is more than 1 s off; fix NTP before trusting order times" : "ok" });

  const runs = new Map<string, string>();
  // Network sessions are always transcribed live (the file model is for replays only).
  const liveStt = sttName(engine.streaming, { sourceType: "hme_ws" });
  const runFor = (storeId: string, laneId: string): string => {
    const key = `${storeId}:${laneId}`;
    let id = runs.get(key);
    if (!id) {
      id = newId("run");
      runs.set(key, id);
      insertRun(db, { id, source_file: `live ${storeId}/${laneId}`, file_path: "", options: { via: "hme_ws", transcriber: liveStt, extractor: engine.extractor.name } });
      updateRun(db, id, { status: "running", stage: "live", transcriber: liveStt, extractor: engine.extractor.name });
    }
    return id;
  };

  const record = opts.record ?? true;
  const live = opts.liveFeed === false ? null : liveWriter(db);
  const manager = new LaneManager({
    engine,
    transcriber: engine.streaming,
    runId: runFor,
    deliver: opts.deliver ?? true,
    record,
    onUpdate: (lane, u) => {
      // Keep the run record current so the existing run view shows live lanes.
      if (u.type === "order" || (u.type === "tracker" && u.decision.to === "FINALIZED")) {
        updateRun(db, lane.runId, { transcript: lane.transcript(), segmentation: lane.segmentation(), audio: lane.transcript().audio });
      }
      live?.(lane, u);
      opts.onUpdate?.(lane, u);
    },
  });

  const sink = record
    ? new RawCaptureSink({
        data: engine.data,
        staging: opts.stagingRoot ?? path.join(cfg.paths.dataDir, "staging", "raw"),
        // Disk guard: capture stops at 95% of the budget; the open conversation says so.
        onPaused: (storeId, laneId) => manager.lane(storeId, laneId)?.flag("capture_paused"),
        log,
      })
    : null;
  if (sink) {
    const n = await sink.recover();
    if (n) log({ event: "raw_capture_recovered", parts: n });
  }
  const usage = engine.data.usage(true);
  if (usage.state !== "ok") log({ event: "disk_budget", state: usage.state, used_bytes: usage.total, budget_bytes: usage.budget });

  // One lane's failure is logged, never an unhandled rejection that would stop every lane.
  const handle = (m: SourceMessage): void => {
    manager.handle(m).catch((e: unknown) => log({ severity: "ERROR", event: "lane_error", kind: m.kind, message: (e as Error).message }));
  };
  const server = new IngestServer({
    db,
    host: opts.host ?? cfg.ingest.host,
    port: opts.port ?? cfg.ingest.port,
    onMessage: (m) => handle(m),
    onRateExceeded: (storeId, laneId) => manager.lane(storeId, laneId)?.flag("audio_rate_exceeded"),
    ...(sink
      ? {
          onSessionOpened: (s) => sink.open(s),
          capture: (s, kind, bytes, at) => sink.write(s.sessionId, kind, bytes, at),
          onSessionClosed: (sessionId) => sink.close(sessionId),
        }
      : {}),
    allowQueryToken: cfg.ingest.allowQueryToken,
    sessions: {
      list: () => manager.sessions(),
      stop: (sessionId, mode) => {
        sink?.tag(sessionId, mode === "end" ? "ended" : "discarded");
        return manager.stop(sessionId, mode, new Date().toISOString());
      },
    },
    enableDevRoutes: devRoutes,
    // Peers may name a fixture only for the free script transcriber (dev routes), never a paid one.
    resolveFixture: devRoutes && engine.streaming instanceof ScriptStreamingTranscriber ? fixtureResolver(cfg.paths.fixturesDir) : undefined,
    allowInsecure: cfg.ingest.allowInsecure,
    ...(cfg.ingest.tlsCert && cfg.ingest.tlsKey ? { tls: { cert: cfg.ingest.tlsCert, key: cfg.ingest.tlsKey } } : {}),
    log,
  });
  await server.listen();

  // Live lanes run on the wall clock: timers (settle, idle, grace) advance even with no audio.
  const ticker = setInterval(() => handle({ kind: "tick", at: new Date().toISOString() }), 250);
  ticker.unref?.();
  log({ event: "ingest_listening", host: server.address.host, port: server.address.port, dev_routes: devRoutes, transcriber: engine.streaming.name });

  return {
    server,
    manager,
    stop: async () => {
      clearInterval(ticker);
      await server.close();
      await sink?.flush();
      await manager.end();
      for (const id of runs.values()) updateRun(db, id, { status: "completed", stage: "done" });
      await engine.deliverer.settle();
    },
  };
}
