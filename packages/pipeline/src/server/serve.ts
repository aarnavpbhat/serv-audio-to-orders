/**
 * pnpm feed serve: the live service. HME base stations (or the simulator, or a
 * replay acting as a base station) connect to the WebSocket endpoint; each
 * store_id:lane_id gets a lane with its own streaming transcriber and tracker;
 * finished conversations become orders and webhooks.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Engine } from "../engine";
import { newId } from "../lib/ids";
import { ntpOffsetMs } from "../lib/sntp";
import { LaneManager } from "../lane/manager";
import type { LaneSession, LaneUpdate } from "../lane/lane";
import { insertRun, updateRun } from "../store/db";
import { RawWriter, recoverOpenParts } from "../store/raw-capture";
import { IngestServer } from "./ingest-server";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Lane updates for the live UI. */
  onUpdate?: (lane: LaneSession, update: LaneUpdate) => void;
  /** Override ENABLE_DEV_ROUTES (tests and the eval's in-process checks). */
  devRoutes?: boolean;
  /** Raw capture root (default DATA_DIR/raw). Null turns capture off. */
  rawRoot?: string | null;
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
  const runFor = (storeId: string, laneId: string): string => {
    const key = `${storeId}:${laneId}`;
    let id = runs.get(key);
    if (!id) {
      id = newId("run");
      runs.set(key, id);
      insertRun(db, { id, source_file: `live ${storeId}/${laneId}`, file_path: "", options: { via: "hme_ws", transcriber: engine.streaming.name, extractor: engine.extractor.name } });
      updateRun(db, id, { status: "running", stage: "live", transcriber: engine.streaming.name, extractor: engine.extractor.name });
    }
    return id;
  };

  const manager = new LaneManager({
    engine,
    transcriber: engine.streaming,
    runId: runFor,
    deliver: opts.deliver ?? true,
    onUpdate: (lane, u) => {
      // Keep the run record current so the existing run view shows live lanes.
      if (u.type === "order" || (u.type === "tracker" && u.decision.to === "FINALIZED")) {
        updateRun(db, lane.runId, { transcript: lane.transcript(), segmentation: lane.segmentation(), audio: lane.transcript().audio });
      }
      opts.onUpdate?.(lane, u);
    },
  });

  const rawRoot = opts.rawRoot === undefined ? path.join(cfg.paths.dataDir, "raw") : opts.rawRoot;
  if (rawRoot) {
    const n = recoverOpenParts(rawRoot);
    if (n) log({ event: "raw_capture_recovered", parts: n });
  }
  const writers = new Map<string, RawWriter>();

  const server = new IngestServer({
    db,
    host: opts.host ?? cfg.ingest.host,
    port: opts.port ?? cfg.ingest.port,
    onMessage: (m) => void manager.handle(m),
    onRateExceeded: (storeId, laneId) => manager.lane(storeId, laneId)?.flag("audio_rate_exceeded"),
    capture: rawRoot
      ? (s, kind, bytes, at) => {
          let w = writers.get(s.sessionId);
          if (!w) {
            w = new RawWriter(RawWriter.sessionDir(rawRoot, s.storeId, s.laneId, s.sessionId));
            writers.set(s.sessionId, w);
          }
          w.write(kind, bytes, at);
        }
      : undefined,
    onSessionClosed: (sessionId) => {
      writers.get(sessionId)?.close();
      writers.delete(sessionId);
    },
    allowQueryToken: cfg.ingest.allowQueryToken,
    enableDevRoutes: devRoutes,
    resolveFixture: devRoutes && engine.streaming.name.startsWith("script") ? fixtureResolver(cfg.paths.fixturesDir) : undefined,
    allowInsecure: cfg.ingest.allowInsecure,
    ...(cfg.ingest.tlsCert && cfg.ingest.tlsKey ? { tls: { cert: cfg.ingest.tlsCert, key: cfg.ingest.tlsKey } } : {}),
    log,
  });
  await server.listen();

  // Live lanes run on the wall clock: timers (settle, idle, grace) advance even with no audio.
  const ticker = setInterval(() => void manager.handle({ kind: "tick", at: new Date().toISOString() }), 250);
  ticker.unref?.();
  log({ event: "ingest_listening", host: server.address.host, port: server.address.port, dev_routes: devRoutes, transcriber: engine.streaming.name });

  return {
    server,
    manager,
    stop: async () => {
      clearInterval(ticker);
      await server.close();
      for (const w of writers.values()) w.close();
      await manager.end();
      for (const id of runs.values()) updateRun(db, id, { status: "completed", stage: "done" });
      await engine.deliverer.settle();
    },
  };
}
