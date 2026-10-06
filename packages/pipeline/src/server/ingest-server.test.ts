/** Part A: ingest token auth and endpoint limits, over a real socket. */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openDb } from "../store/db";
import { createToken, issueTicket, revokeToken } from "../input/auth/tokens";
import type { SourceMessage } from "../input/types";
import { encodeForWire } from "../input/encoders";
import { CLOSE, IngestServer, MAX_TEXT_BYTES, parseFormat } from "./ingest-server";

const db = openDb(":memory:");
const servers: IngestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(over: Partial<ConstructorParameters<typeof IngestServer>[0]> = {}) {
  const got: SourceMessage[] = [];
  const s = new IngestServer({ db, host: "127.0.0.1", port: 0, onMessage: (m) => got.push(m), allowQueryToken: false, enableDevRoutes: false, allowInsecure: false, revocationPollMs: 50, ...over });
  await s.listen();
  servers.push(s);
  return { s, got, url: `ws://127.0.0.1:${s.address.port}/hme/v1/stream` };
}

/** Connect and resolve with "open" or the HTTP status that refused it. */
function connect(url: string, headers: Record<string, string> = {}): Promise<{ status: number | "open"; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ status: "open", ws }));
    ws.once("unexpected-response", (_r, res) => resolve({ status: res.statusCode ?? 0, ws }));
    ws.once("error", () => {});
  });
}
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once("close", (code) => r(code)));
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ingest token auth", () => {
  const { token, tokenId } = createToken(db, { storeId: "store_a", lanes: ["lane_1", "lane_2"], note: "test" });

  it("token format: sit_<12 base32>_<43 base64url>, secret stored only as a hash", () => {
    expect(token).toMatch(/^sit_[A-Z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    const row = db.prepare(`SELECT * FROM ingest_tokens WHERE token_id = ?`).get(tokenId) as { secret_sha256: string };
    expect(row.secret_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token.split("_").slice(2).join("_"));
  });

  it("a valid token connects; the store comes from the token, the lane from ?lane=", async () => {
    const { url, got } = await start();
    const { status, ws } = await connect(`${url}?lane=lane_1`, bearer(token));
    expect(status).toBe("open");
    ws.close();
    const open = got.find((m) => m.kind === "session_open");
    expect(open?.kind === "session_open" && [open.session.storeId, open.session.laneId, open.session.timeBasis]).toEqual(["store_a", "lane_1", "receive_clock"]);
    expect((db.prepare(`SELECT last_used_at FROM ingest_tokens WHERE token_id = ?`).get(tokenId) as { last_used_at: number }).last_used_at).toBeGreaterThan(0);
  });

  it("wrong secret, unknown id, malformed, missing header and a lane not allowed all get the same 401", async () => {
    const { url } = await start();
    const wrong = token.slice(0, -4) + "AAAA";
    const unknown = `sit_ABCDEFGHIJKL_${token.split("_").slice(2).join("_")}`;
    for (const [q, h] of [
      ["?lane=lane_1", bearer(wrong)],
      ["?lane=lane_1", bearer(unknown)],
      ["?lane=lane_1", bearer("sit_short")],
      ["?lane=lane_1", {}],
      ["?lane=lane_9", bearer(token)],
    ] as const) {
      expect((await connect(`${url}${q}`, h)).status).toBe(401);
    }
    const reasons = (db.prepare(`SELECT reason FROM ingest_auth_log WHERE result = '401' ORDER BY id`).all() as { reason: string }[]).map((r) => r.reason);
    expect(reasons).toEqual(expect.arrayContaining(["wrong_secret", "unknown", "malformed", "missing"]));
    const logged = JSON.stringify(db.prepare(`SELECT * FROM ingest_auth_log`).all());
    expect(logged).not.toContain(token.split("_").slice(2).join("_"));
  });

  it("a revoked token is refused", async () => {
    const t = createToken(db, { storeId: "store_r", lanes: ["lane_1"] });
    revokeToken(db, t.tokenId);
    const { url } = await start();
    expect((await connect(`${url}?lane=lane_1`, bearer(t.token))).status).toBe(401);
  });

  it("?token= is refused unless INGEST_AUTH_ALLOW_QUERY is on", async () => {
    const off = await start();
    expect((await connect(`${off.url}?lane=lane_1&token=${token}`)).status).toBe(401);
    const on = await start({ allowQueryToken: true });
    const r = await connect(`${on.url}?lane=lane_1&token=${token}`);
    expect(r.status).toBe("open");
    r.ws.close();
  });

  it("more than 10 failed attempts a minute from one IP gets 429", async () => {
    const fresh = openDb(":memory:");
    const { url } = await start({ db: fresh });
    for (let i = 0; i < 10; i++) expect((await connect(`${url}?lane=lane_1`, bearer("sit_bad"))).status).toBe(401);
    expect((await connect(`${url}?lane=lane_1`, bearer("sit_bad"))).status).toBe(429);
  });

  it("tickets: single use, expire, and only with dev routes", async () => {
    const dev = await start({ enableDevRoutes: true });
    const { ticket } = issueTicket(db, { storeId: "store_sim", laneId: "lane_1" });
    const first = await connect(`${dev.url}?ticket=${ticket}`);
    expect(first.status).toBe("open");
    first.ws.close();
    expect((await connect(`${dev.url}?ticket=${ticket}`)).status).toBe(401);
    const old = issueTicket(db, { storeId: "store_sim", laneId: "lane_1", ttlMs: 1 });
    await wait(10);
    expect((await connect(`${dev.url}?ticket=${old.ticket}`)).status).toBe(401);
    const prod = await start({ enableDevRoutes: false });
    const t2 = issueTicket(db, { storeId: "store_sim", laneId: "lane_1" });
    expect((await connect(`${prod.url}?ticket=${t2.ticket}`)).status).toBe(401);
  });

  it("revoking a token closes its live sessions with 4401", async () => {
    const t = createToken(db, { storeId: "store_v", lanes: ["lane_1"] });
    const { url } = await start();
    const { ws } = await connect(`${url}?lane=lane_1`, bearer(t.token));
    const code = closed(ws);
    revokeToken(db, t.tokenId);
    expect(await code).toBe(CLOSE.revoked);
  });
});

describe("endpoint limits", () => {
  const { token } = createToken(db, { storeId: "store_l", lanes: ["lane_1", "lane_2", "lane_3", "lane_4", "lane_5", "lane_6"] });

  it("refuses a non-local address without TLS", () => {
    expect(() => new IngestServer({ db, host: "0.0.0.0", port: 0, onMessage: () => {}, allowQueryToken: false, enableDevRoutes: false, allowInsecure: false })).toThrow(/without TLS/);
  });

  it("validates the declared format", () => {
    expect(parseFormat(new URLSearchParams("codec=speex")).ok).toBe(false);
    expect(parseFormat(new URLSearchParams("rate=4000")).ok).toBe(false);
    expect(parseFormat(new URLSearchParams("channels=2&roles=customer")).ok).toBe(false);
    expect(parseFormat(new URLSearchParams("codec=mulaw&rate=8000&channels=2&roles=customer,crew"))).toMatchObject({ ok: true, codec: "mulaw", sampleRate: 8000 });
  });

  it("an oversize text message closes with 1009; binary over 64 KB too", async () => {
    const { url } = await start();
    const a = await connect(`${url}?lane=lane_1`, bearer(token));
    const codeA = closed(a.ws);
    a.ws.send("x".repeat(MAX_TEXT_BYTES + 1));
    expect(await codeA).toBe(CLOSE.tooBig);
    const b = await connect(`${url}?lane=lane_2`, bearer(token));
    const codeB = closed(b.ws);
    b.ws.send(new Uint8Array(64 * 1024 + 1), { binary: true });
    expect(await codeB).toBe(1009);
  });

  it("a second connection for the same store and lane replaces the first (4409)", async () => {
    const { url } = await start();
    const first = await connect(`${url}?lane=lane_3`, bearer(token));
    const code = closed(first.ws);
    const second = await connect(`${url}?lane=lane_3`, bearer(token));
    expect(second.status).toBe("open");
    expect(await code).toBe(CLOSE.replaced);
    second.ws.close();
  });

  it("at most 4 connections per token", async () => {
    const t = createToken(db, { storeId: "store_m", lanes: ["a1", "a2", "a3", "a4", "a5"] });
    const { url } = await start();
    const open = [];
    for (const lane of ["a1", "a2", "a3", "a4"]) open.push(await connect(`${url}?lane=${lane}`, bearer(t.token)));
    expect(open.every((o) => o.status === "open")).toBe(true);
    expect((await connect(`${url}?lane=a5`, bearer(t.token))).status).toBe(429);
    for (const o of open) o.ws.close();
  });

  it("PCM over the socket arrives as canonical frames; JSON text becomes control events", async () => {
    const { url, got } = await start();
    const { ws } = await connect(`${url}?lane=lane_4&codec=pcm_s16le&rate=16000&channels=1`, bearer(token));
    ws.send(new Uint8Array(3200), { binary: true });
    ws.send(JSON.stringify({ type: "vehicle_arrived" }));
    ws.send(JSON.stringify({ type: "something_new", x: 1 }));
    await wait(50);
    ws.close();
    await wait(50);
    const audio = got.filter((m) => m.kind === "audio");
    expect(audio.reduce((n, m) => n + (m.kind === "audio" ? (m.frame.pcm[0]?.length ?? 0) : 0), 0)).toBe(1600);
    const controls = got.flatMap((m) => (m.kind === "control" ? [m.event.type] : []));
    expect(controls).toEqual(["vehicle_arrived", "unknown"]);
    expect(got.at(-1)?.kind).toBe("session_close");
  });

  it("shutting down right after a session ends still decodes its last audio and closes it", async () => {
    const { s, url, got } = await start();
    const wire = await encodeForWire([new Int16Array(16000).fill(2000)], "flac", 100);
    const { ws } = await connect(`${url}?lane=lane_6&codec=flac&rate=16000&channels=1`, bearer(token));
    for (const chunk of wire) ws.send(chunk, { binary: true });
    await new Promise((r) => {
      ws.once("close", r);
      ws.close(1000);
    });
    await s.close();
    const samples = got.reduce((n, m) => n + (m.kind === "audio" ? (m.frame.pcm[0]?.length ?? 0) : 0), 0);
    expect(samples).toBeGreaterThan(15000);
    expect(got.at(-1)?.kind).toBe("session_close");
  });

  it("a peer cannot name a fixture (sourceRef) without dev routes", async () => {
    const { url } = await start({ resolveFixture: () => "/etc/passwd" });
    expect((await connect(`${url}?lane=lane_5&fixture=01_simple`, bearer(token))).status).toBe(400);
    const dev = await start({ enableDevRoutes: true, resolveFixture: () => null });
    expect((await connect(`${dev.url}?lane=lane_5&fixture=../../etc/passwd`, bearer(token))).status).toBe(400);
  });

  describe("operator stop (dev routes, E3)", () => {
    const stopReq = (port: number, id: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
      fetch(`http://127.0.0.1:${port}/dev/sessions/${id}/stop`, { method: "POST", headers, body: JSON.stringify(body) });

    it("closes the client's socket with 4000 and tells the lanes; a second stop does nothing", async () => {
      const stops: [string, string][] = [];
      const { s, url, got } = await start({ enableDevRoutes: true, sessions: { list: () => [{ sessionId: "x" }], stop: async (id, mode) => (stops.push([id, mode]), true) } });
      const { ws } = await connect(`${url}?lane=lane_1`, bearer(token));
      await wait(30);
      const open = got.find((m) => m.kind === "session_open");
      const id = open?.kind === "session_open" ? open.session.sessionId : "";
      const code = closed(ws);
      const res = await stopReq(s.address.port, id, { mode: "end" });
      expect(await res.json()).toEqual({ stopped: true, mode: "end" });
      expect(await code).toBe(CLOSE.stopped);
      await wait(30);
      expect(got.filter((m) => m.kind === "session_close")).toHaveLength(1);
      expect((await stopReq(s.address.port, id, { mode: "end" })).status).toBe(200);
      expect(stops).toEqual([
        [id, "end"],
        [id, "end"],
      ]);
      expect(await (await fetch(`http://127.0.0.1:${s.address.port}/dev/sessions`)).json()).toEqual({ sessions: [{ sessionId: "x" }] });
    });

    it("refuses a bad mode, a non-JSON body, and everything without dev routes", async () => {
      const control = { list: () => [], stop: async () => true };
      const on = await start({ enableDevRoutes: true, sessions: control });
      expect((await stopReq(on.s.address.port, "ses_1", { mode: "explode" })).status).toBe(400);
      expect((await stopReq(on.s.address.port, "ses_1", { mode: "end" }, { "content-type": "text/plain" })).status).toBe(400);
      const off = await start({ enableDevRoutes: false, sessions: control });
      expect((await stopReq(off.s.address.port, "ses_1", { mode: "end" })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${off.s.address.port}/dev/sessions`)).status).toBe(404);
    });
  });
});
