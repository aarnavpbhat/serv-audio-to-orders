/**
 * Raw capture into the data store. Each session's messages are staged on local
 * disk by a RawWriter (DATA_DIR/staging/raw/<store>/<lane>/<session>); every
 * finished part is uploaded under raw/store=/lane=/date=/session=/ with its
 * index, catalogued, and removed from staging. A session.json manifest (the
 * declared format) goes first, so a session can be replayed byte for byte.
 *
 * The disk guard pauses capture at 95% of the budget: messages are no longer
 * kept (orders keep flowing) and the lane is told, so its order says capture_paused.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodePart, RawWriter, recoverOpenParts, type RollInfo } from "../store/raw-capture";
import { keys, type DataStore } from "./store";

export interface RawSessionManifest {
  session_id: string;
  store_id: string;
  lane_id: string;
  token_id: string;
  opened_at: string;
  /** Declared on connect (PLACEHOLDER wire format). */
  format: { codec: string; sampleRate: number; channels: number; roles: string[] | null };
  wire: string;
  /** Set when an operator stopped the session (E3, E4). Discarded sessions are kept but left out of metrics. */
  stopped?: "ended" | "discarded";
}

interface Live {
  manifest: RawSessionManifest;
  writer: RawWriter;
  paused: boolean;
}

export interface RawSinkOptions {
  data: DataStore;
  /** Local staging root for parts being written. */
  staging: string;
  rollMs?: number;
  rollBytes?: number;
  /** Called once per session when the disk guard stops its capture. */
  onPaused?: (storeId: string, laneId: string) => void;
  log?: (line: Record<string, unknown>) => void;
}

const MANIFEST = "session.json";

export class RawCaptureSink {
  private readonly live = new Map<string, Live>();
  private readonly writes = new Set<Promise<unknown>>();

  constructor(private readonly opts: RawSinkOptions) {}

  private track(p: Promise<unknown>): void {
    const q = p
      .catch((e: unknown) => this.opts.log?.({ event: "raw_capture_store_failed", error: (e as Error).message.slice(0, 300) }))
      .finally(() => this.writes.delete(q));
    this.writes.add(q);
  }

  open(s: { sessionId: string; storeId: string; laneId: string; tokenId: string; openedAt: number; format: RawSessionManifest["format"] }): void {
    const manifest: RawSessionManifest = {
      session_id: s.sessionId,
      store_id: s.storeId,
      lane_id: s.laneId,
      token_id: s.tokenId,
      opened_at: new Date(s.openedAt).toISOString(),
      format: s.format,
      wire: "hme/v1 PLACEHOLDER: binary = audio in the declared codec, text = JSON control events",
    };
    const dir = RawWriter.sessionDir(this.opts.staging, s.storeId, s.laneId, s.sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
    const writer = new RawWriter(dir, {
      ...(this.opts.rollMs ? { rollMs: this.opts.rollMs } : {}),
      ...(this.opts.rollBytes ? { rollBytes: this.opts.rollBytes } : {}),
      onRoll: (info) => this.upload(manifest, info),
    });
    this.live.set(s.sessionId, { manifest, writer, paused: false });
    this.track(this.putManifest(manifest));
  }

  write(sessionId: string, kind: "binary" | "text", bytes: Uint8Array, receivedAt: number): void {
    const l = this.live.get(sessionId);
    if (!l) return;
    if (this.opts.data.capturePaused()) {
      if (!l.paused) {
        l.paused = true;
        this.opts.log?.({ event: "raw_capture_paused", session_id: sessionId, reason: "disk budget at 95%" });
        this.opts.onPaused?.(l.manifest.store_id, l.manifest.lane_id);
      }
      return;
    }
    l.writer.write(kind, bytes, receivedAt);
  }

  /** Record an operator stop in the session's manifest (E4: discarded data is kept, tagged). */
  tag(sessionId: string, stopped: "ended" | "discarded"): void {
    const l = this.live.get(sessionId);
    if (!l || l.manifest.stopped) return;
    l.manifest.stopped = stopped;
    writeFileSync(path.join(RawWriter.sessionDir(this.opts.staging, l.manifest.store_id, l.manifest.lane_id, sessionId), MANIFEST), JSON.stringify(l.manifest, null, 2));
    this.track(this.putManifest(l.manifest));
  }

  close(sessionId: string): void {
    this.live.get(sessionId)?.writer.close();
    this.live.delete(sessionId);
  }

  /** Close every session and wait until every part is stored. */
  async flush(): Promise<void> {
    for (const id of [...this.live.keys()]) this.close(id);
    while (this.writes.size) await Promise.all([...this.writes]);
  }

  private async putManifest(m: RawSessionManifest): Promise<void> {
    await this.opts.data.put("raw", keys.raw(partition(m), m.session_id, MANIFEST), JSON.stringify(m, null, 2), meta(m));
  }

  private upload(m: RawSessionManifest, info: RollInfo): void {
    this.track(
      (async () => {
        const p = partition(m);
        const name = path.basename(info.file).replace(/\.bin\.zst$/, "");
        const bin = await this.opts.data.put("raw", keys.raw(p, m.session_id, `${name}.bin.zst`), readFileSync(info.file), meta(m));
        await this.opts.data.put("raw", keys.raw(p, m.session_id, `${name}.index.ndjson`), readFileSync(info.index), { ...meta(m), derivedFrom: bin ? [bin.id] : [] });
        rmSync(info.file, { force: true });
        rmSync(info.index, { force: true });
      })(),
    );
  }

  /**
   * On start: finish parts a crash left open (marked incomplete) and upload any
   * finished part still in staging. Returns how many parts were recovered.
   */
  async recover(): Promise<number> {
    const root = this.opts.staging;
    if (!existsSync(root)) return 0;
    const manifestFor = (dir: string): RawSessionManifest | null => {
      const f = path.join(dir, MANIFEST);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as RawSessionManifest) : null;
    };
    let n = 0;
    recoverOpenParts(root, () => n++);
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".bin.zst")) {
          const m = manifestFor(dir);
          const index = p.replace(/\.bin\.zst$/, ".index.ndjson");
          if (!m || !existsSync(index)) continue;
          this.upload(m, { dir, part: 0, file: p, index, bytes: 0, messages: 0, incomplete: e.name.includes(".incomplete") });
        }
      }
    };
    walk(root);
    while (this.writes.size) await Promise.all([...this.writes]);
    return n;
  }
}

const partition = (m: RawSessionManifest) => ({ storeId: m.store_id, laneId: m.lane_id, at: m.opened_at });
const meta = (m: RawSessionManifest) => ({ storeId: m.store_id, laneId: m.lane_id, sessionId: m.session_id });

/** Every message of a captured session, in order, plus its manifest (for replay and inspection). */
export async function readRawSession(data: DataStore, sessionId: string): Promise<{ manifest: RawSessionManifest; messages: { kind: "binary" | "text"; receivedAt: string; bytes: Uint8Array }[]; incomplete: boolean }> {
  const rows = data.find({ sessionId, kind: "raw" });
  const manifestRow = rows.find((r) => r.uri.endsWith(`/${MANIFEST}`));
  if (!manifestRow) throw new Error(`No raw capture for session ${sessionId}`);
  const manifest = JSON.parse(new TextDecoder().decode(await data.blobs.get(manifestRow.uri))) as RawSessionManifest;
  const parts = rows
    .filter((r) => r.uri.endsWith(".bin.zst"))
    .map((r) => ({ uri: r.uri, n: Number(/part-(\d+)/.exec(r.uri)?.[1] ?? 0), incomplete: r.uri.includes(".incomplete") }))
    .sort((a, b) => a.n - b.n);
  const messages: { kind: "binary" | "text"; receivedAt: string; bytes: Uint8Array }[] = [];
  for (const p of parts) {
    const index = new TextDecoder().decode(await data.blobs.get(p.uri.replace(/\.bin\.zst$/, ".index.ndjson")));
    for (const { line, bytes } of decodePart(await data.blobs.get(p.uri), index)) messages.push({ kind: line.kind, receivedAt: line.received_at, bytes });
  }
  return { manifest, messages, incomplete: parts.some((p) => p.incomplete) };
}
