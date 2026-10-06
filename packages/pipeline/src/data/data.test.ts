/** Part B: the long-term data store (blob store, catalog, raw capture, retention, disk guard). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { emptyUsage, type LlmCallRecord } from "../extract/types";
import { createToken } from "../input/auth/tokens";
import { int16ToS16le } from "../input/pcm";
import type { SourceMessage } from "../input/types";
import { replayRawOverWs } from "../input/ws-replay";
import { ScriptStreamingTranscriber } from "../lane/script-transcriber";
import { replayFile } from "../lane/replay";
import { IngestServer } from "../server/ingest-server";
import { openDb, orderVersions } from "../store/db";
import { repoRoot, testEngine } from "../test-helpers";
import { assertKey, LocalBlobStore } from "./blob-store";
import { listLabels, putLabel } from "./labels";
import { RawCaptureSink, readRawSession } from "./raw-sink";
import { DataStore, keys, type ArtifactKind } from "./store";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "serv-data-test-"));
const P = { storeId: "store_a", laneId: "lane_1", at: "2026-10-05T18:00:00Z" };

function store(budgetBytes = 50 * 1024 ** 3) {
  const root = tmp();
  const db = openDb(path.join(root, "test.db"));
  const data = new DataStore(db, new LocalBlobStore(path.join(root, "blobs")), { pipelineVersion: "test", budgetBytes, retention: "keep_all" });
  return { db, root, data };
}

/** A real endpoint whose raw capture goes into `data`; returns the frames the lanes would see. */
async function endpoint(data: DataStore, db: ReturnType<typeof openDb>, sinkOpts: { rollBytes?: number } = {}) {
  const got: SourceMessage[] = [];
  const paused: string[] = [];
  const sink = new RawCaptureSink({ data, staging: path.join(tmp(), "staging"), ...sinkOpts, onPaused: (s, l) => paused.push(`${s}:${l}`) });
  const server = new IngestServer({
    db,
    host: "127.0.0.1",
    port: 0,
    onMessage: (m) => got.push(m),
    onSessionOpened: (s) => sink.open(s),
    capture: (s, kind, bytes, at) => sink.write(s.sessionId, kind, bytes, at),
    onSessionClosed: (id) => sink.close(id),
    allowQueryToken: false,
    enableDevRoutes: false,
    allowInsecure: false,
  });
  await server.listen();
  return { server, sink, got, paused, url: `ws://127.0.0.1:${server.address.port}` };
}

/** 20 ms PCM frames of a ramp, plus two control events. */
function wireMessages(n = 40): (Uint8Array | string)[] {
  const out: (Uint8Array | string)[] = [];
  for (let i = 0; i < n; i++) {
    const pcm = Int16Array.from({ length: 320 }, (_, k) => ((i * 320 + k) % 2000) - 1000);
    out.push(int16ToS16le(pcm));
    if (i === 10) out.push(JSON.stringify({ type: "vehicle_arrived", at: "2026-10-05T18:00:00.200Z" }));
    if (i === 30) out.push(JSON.stringify({ type: "vehicle_departed", at: "2026-10-05T18:00:00.600Z" }));
  }
  return out;
}

async function send(url: string, token: string, msgs: (Uint8Array | string)[]): Promise<void> {
  const ws = new WebSocket(`${url}/hme/v1/stream?lane=lane_1&codec=pcm_s16le&rate=16000&channels=1`, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  for (const m of msgs) ws.send(m, { binary: typeof m !== "string" });
  await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => {
    ws.once("close", r);
    ws.close(1000);
  });
  await new Promise((r) => setTimeout(r, 100));
}

/** Audio samples and control events, in order, as the lane receives them. */
function frames(got: SourceMessage[]) {
  const pcm: number[] = [];
  const control: string[] = [];
  for (const m of got) {
    if (m.kind === "audio") pcm.push(...(m.frame.pcm[0] ?? []));
    if (m.kind === "control") control.push(m.event.type);
  }
  return { pcm, control };
}

describe("blob store", () => {
  it("keys are plain segments: no traversal, no absolute paths", () => {
    expect(assertKey("raw/store=a/lane=b/date=2026-10-05/session=s/part-00001.bin.zst")).toHaveLength(6);
    for (const bad of ["../x", "a/../b", "/abs", "a//b", "a/b c", "a\\b"]) expect(() => assertKey(bad)).toThrow();
    expect(() => keys.raw({ ...P, storeId: "../etc" }, "s", "f")).toThrow();
  });
});

describe("raw capture", () => {
  it("replaying a captured session gives identical frames", async () => {
    const { db, data } = store();
    const { token } = createToken(db, { storeId: "store_a", lanes: ["lane_1"] });
    const a = await endpoint(data, db);
    const sent = wireMessages();
    await send(a.url, token, sent);
    await a.sink.flush();
    const sessionId = a.got.find((m) => m.kind === "session_open")?.kind === "session_open" ? (a.got.find((m) => m.kind === "session_open") as Extract<SourceMessage, { kind: "session_open" }>).session.sessionId : "";

    // Stored byte for byte, kinds kept.
    const raw = await readRawSession(data, sessionId);
    expect(raw.messages.map((m) => (m.kind === "text" ? new TextDecoder().decode(m.bytes) : Buffer.from(m.bytes).toString("hex")))).toEqual(
      sent.map((m) => (typeof m === "string" ? m : Buffer.from(m).toString("hex"))),
    );
    expect(raw.manifest.format).toEqual({ codec: "pcm_s16le", sampleRate: 16000, channels: 1, roles: null });

    // Replayed into a second endpoint: the lane sees the same frames and events.
    const b = await endpoint(data, db);
    await replayRawOverWs(data, sessionId, { url: b.url, token });
    await new Promise((r) => setTimeout(r, 150));
    expect(frames(b.got)).toEqual(frames(a.got));
    expect(frames(a.got).pcm.length).toBe(40 * 320);
    await Promise.all([a.server.close(), b.server.close()]);
  });

  it("rolls parts by size; every part is catalogued and read back in order", async () => {
    const { db, data } = store();
    const { token } = createToken(db, { storeId: "store_a", lanes: ["lane_1"] });
    const a = await endpoint(data, db, { rollBytes: 4000 });
    await send(a.url, token, wireMessages());
    await a.sink.flush();
    const parts = data.find({ kind: "raw" }).filter((r) => r.uri.endsWith(".bin.zst"));
    expect(parts.length).toBeGreaterThan(3);
    expect(data.find({ kind: "raw" }).filter((r) => r.uri.endsWith(".index.ndjson"))).toHaveLength(parts.length);
    expect(parts.every((r) => /^raw\/store=store_a\/lane=lane_1\/date=\d{4}-\d{2}-\d{2}\/session=[^/]+\/part-\d{5}\.bin\.zst$/.test(r.uri))).toBe(true);
    const sessionId = parts[0]?.session_id ?? "";
    expect((await readRawSession(data, sessionId)).messages).toHaveLength(42);
    await a.server.close();
  });

  it("the disk guard pauses capture at 95% and says so once per session; orders keep flowing", async () => {
    const { db, data } = store(1000);
    await data.put("llm", keys.llm(P, "ord_x", "h1"), "x".repeat(960), { storeId: "store_a", laneId: "lane_1" });
    expect(data.usage(true).state).toBe("paused");
    const { token } = createToken(db, { storeId: "store_a", lanes: ["lane_1"] });
    const a = await endpoint(data, db);
    await send(a.url, token, wireMessages(5));
    await a.sink.flush();
    expect(a.paused).toEqual(["store_a:lane_1"]);
    expect(data.find({ kind: "raw" })).toHaveLength(0);
    expect(frames(a.got).pcm.length).toBe(5 * 320);
    // Audio is paused too; LLM records and labels are not.
    expect(await data.put("audio", keys.audio(P, "ord_x", 1), new Uint8Array(10), { storeId: "store_a", laneId: "lane_1" })).toBeNull();
    expect(await data.put("llm", keys.llm(P, "ord_x", "h2"), "{}", { storeId: "store_a", laneId: "lane_1" })).not.toBeNull();
    await a.server.close();
  });

  it("warns at 80% of the budget", async () => {
    const { data } = store(1000);
    await data.put("events", keys.events(P, "ses_1"), "x".repeat(850), { storeId: "store_a", laneId: "lane_1" });
    expect(data.usage(true).state).toBe("warn");
  });
});

describe("catalog", () => {
  it("a recorded replay catalogues audio, LLM calls and events for its orders; labels attach to a version", async () => {
    const engine = testEngine();
    const inner = engine.extractor;
    const call: LlmCallRecord = { request_hash: "abc123", site: "extract", model: "stub", prompt_version: "t", system_sha256: "0", contents: [{ role: "user", text: "u" }], response_text: "{}", usage: emptyUsage("stub"), cached: false, at: P.at };
    engine.extractor = { name: "stub", extract: async (i) => ({ ...(await inner.extract(i)), calls: [call] }) };
    const r = await replayFile(engine, path.join(repoRoot, "fixtures/audio/01_simple.mono.clean.mp3"), { transcriber: new ScriptStreamingTranscriber(), deliver: false, record: true, storeId: "store_a", laneId: "lane_1" });
    const order = r.orders[0];
    expect(order).toBeDefined();
    const id = order?.payload.order_id ?? "";

    // The payload points at the archived audio.
    const uri = order?.payload.audio_ref.archive_uri ?? "";
    expect(uri).toMatch(/^audio\/store=store_a\/lane=lane_1\/date=\d{4}-\d{2}-\d{2}\/order=ord_[A-Z0-9]+\/v1\.flac$/);
    const flac = await engine.data.blobs.get(uri);
    expect(new TextDecoder().decode(flac.subarray(0, 4))).toBe("fLaC");

    await putLabel(engine.db, engine.data, id, { order_version: 1, verdict: "correct", author: "tester" });
    expect((await listLabels(engine.data, id)).map((l) => l.verdict)).toEqual(["correct"]);
    await expect(putLabel(engine.db, engine.data, id, { order_version: 9, verdict: "correct", author: "tester" })).rejects.toThrow(/no version 9/);

    const kinds = new Set(engine.data.find({ orderId: id }).map((a) => a.kind));
    expect([...kinds].sort()).toEqual(["audio", "events", "labels", "llm"] satisfies ArtifactKind[]);
    for (const a of engine.data.find({ orderId: id })) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.pipeline_version).toBe("test");
      expect([a.store_id, a.lane_id]).toEqual(["store_a", "lane_1"]);
    }
    const events = engine.data.find({ kind: "events" })[0];
    const lines = new TextDecoder().decode(await engine.data.blobs.get(events?.uri ?? "")).trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(lines[0]?.type).toBe("session_open");
    expect(lines.some((l) => l.type === "tracker_decision")).toBe(true);
    expect(lines.at(-1)?.type).toBe("session_close");
  });

  it("delete by store removes that store's blobs, marks rows, writes a tombstone, and keeps orders", async () => {
    const engine = testEngine();
    const r = await replayFile(engine, path.join(repoRoot, "fixtures/audio/01_simple.mono.clean.mp3"), { transcriber: new ScriptStreamingTranscriber(), deliver: false, record: true, storeId: "store_a", laneId: "lane_1" });
    await engine.data.put("events", keys.events({ ...P, storeId: "store_b" }, "ses_b"), "{}\n", { storeId: "store_b", laneId: "lane_1" });
    const before = engine.data.find({ storeId: "store_a" });
    expect(before.length).toBeGreaterThan(0);

    const res = await engine.data.deleteWhere({ storeId: "store_a" });
    expect(res.artifacts).toBe(before.length);
    for (const a of before) expect(await engine.data.blobs.exists(a.uri)).toBe(false);
    expect(engine.data.find({ storeId: "store_a" })).toHaveLength(0);
    expect(engine.data.find({ storeId: "store_a", includeDeleted: true }).every((a) => a.deleted_at !== null)).toBe(true);
    expect(engine.data.find({ storeId: "store_b" })).toHaveLength(1);
    expect(engine.db.prepare(`SELECT scope, value, artifacts FROM data_tombstones`).all()).toEqual([{ scope: "store", value: "store_a", artifacts: before.length }]);
    // Orders and their versions are never deleted.
    expect(orderVersions(engine.db, r.orders[0]?.payload.order_id ?? "")).toHaveLength(1);
  });

  it("prune removes one kind older than N days", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const dir = tmp();
    const db = openDb(path.join(dir, "test.db"));
    const data = new DataStore(db, new LocalBlobStore(path.join(dir, "blobs")), { pipelineVersion: "t", budgetBytes: 1e12, retention: "keep_all", now: () => now });
    await data.put("asr", keys.asr(P, "ses_1", 1), "[]", { storeId: "store_a", laneId: "lane_1", sessionId: "ses_1" });
    await data.put("llm", keys.llm(P, "ord_1", "h"), "{}", { storeId: "store_a", laneId: "lane_1" });
    now += 40 * 86_400_000;
    await data.put("asr", keys.asr(P, "ses_2", 1), "[]", { storeId: "store_a", laneId: "lane_1", sessionId: "ses_2" });
    expect((await data.prune("asr", 30)).artifacts).toBe(1);
    expect(data.find({ kind: "asr" }).map((a) => a.session_id)).toEqual(["ses_2"]);
    expect(data.find({ kind: "llm" })).toHaveLength(1);
  });

  it("verify finds a changed blob and a missing one", async () => {
    const { data, root } = store();
    const a = await data.put("events", keys.events(P, "ses_1"), "one\n", { storeId: "store_a", laneId: "lane_1" });
    const b = await data.put("events", keys.events(P, "ses_2"), "two\n", { storeId: "store_a", laneId: "lane_1" });
    await data.put("events", keys.events(P, "ses_3"), "three\n", { storeId: "store_a", laneId: "lane_1" });
    expect((await data.verify()).mismatches).toEqual([]);
    writeFileSync(path.join(root, "blobs", ...(a?.uri ?? "").split("/")), "tampered\n");
    rmSync(path.join(root, "blobs", ...(b?.uri ?? "").split("/")));
    const r = await data.verify();
    expect(r.checked).toBe(3);
    expect(r.mismatches.map((m) => [m.uri, m.problem]).sort()).toEqual([
      [a?.uri, "hash"],
      [b?.uri, "missing"],
    ]);
  });
});
