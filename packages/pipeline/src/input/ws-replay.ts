/**
 * A fake HME base station: replays a recording to the WebSocket endpoint using
 * the PLACEHOLDER wire format (audio in the scenario's codec as binary
 * messages, events as JSON text), reconnecting as the scenario says. Proves
 * the network path, auth, raw capture and decoders end to end.
 */
import WebSocket from "ws";
import { readRawSession } from "../data/raw-sink";
import type { DataStore } from "../data/store";
import { sleep as realSleep } from "../lib/retry";
import { encodeForWire } from "./encoders";
import { FileReplaySource, type ReplayOptions } from "./file-replay";
import type { SourceMessage } from "./types";

export interface WsReplayOptions extends ReplayOptions {
  /** Endpoint base, e.g. ws://127.0.0.1:8787 */
  url: string;
  /** Bearer token, or a function returning a fresh one-time ticket per connection (dev). */
  token?: string;
  ticket?: () => string | Promise<string>;
  /** Dev only: tell the server which fixture this is, for the free script transcriber. */
  fixtureId?: string;
  log?: (msg: string) => void;
}

export interface WsReplayResult {
  sessions: number;
  messages: number;
  bytes: number;
  closes: { code: number; reason: string }[];
}

export async function replayOverWs(file: string, opts: WsReplayOptions): Promise<WsReplayResult> {
  const source = new FileReplaySource(file, opts);
  const sc = source.scenario;
  const timed = await source.plan();
  const sleep = opts.sleep ?? realSleep;
  const speed = opts.speed ?? "max";
  const result: WsReplayResult = { sessions: 0, messages: 0, bytes: 0, closes: [] };

  // Encode each session's audio in the wire codec up front, then spread the
  // wire messages over that session's frame times.
  const framesBySession = new Map<string, Extract<SourceMessage, { kind: "audio" }>[]>();
  const messages = timed.map((t) => ({ t: t.t, m: t.make() }));
  for (const { m } of messages) if (m.kind === "audio") framesBySession.set(m.frame.sessionId, [...(framesBySession.get(m.frame.sessionId) ?? []), m]);
  const wireFor = new Map<string, Map<number, Uint8Array[]>>();
  for (const [sid, frames] of framesBySession) {
    const channels = frames[0]?.frame.pcm.length ?? 1;
    const total = frames.reduce((n, f) => n + (f.frame.pcm[0]?.length ?? 0), 0);
    const pcm = Array.from({ length: channels }, (_, c) => {
      const out = new Int16Array(total);
      let o = 0;
      for (const f of frames) {
        const ch = f.frame.pcm[c] ?? new Int16Array(0);
        out.set(ch, o);
        o += ch.length;
      }
      return out;
    });
    const wire = await encodeForWire(pcm, sc.codec, sc.frame_ms);
    const byFrame = new Map<number, Uint8Array[]>();
    wire.forEach((chunk, i) => {
      const idx = Math.min(frames.length - 1, Math.floor((i * frames.length) / Math.max(1, wire.length)));
      const seq = frames[idx]?.frame.seq ?? 0;
      byFrame.set(seq, [...(byFrame.get(seq) ?? []), chunk]);
    });
    wireFor.set(sid, byFrame);
  }

  let ws: WebSocket | null = null;
  let current: string | null = null;
  const wallStart = Date.now();
  for (const { t, m } of messages) {
    if (speed !== "max") {
      const wait = wallStart + (t * 1000) / speed - Date.now();
      if (wait > 0) await sleep(wait);
    }
    switch (m.kind) {
      case "session_open": {
        const q = new URLSearchParams({
          lane: m.session.laneId,
          codec: sc.codec,
          rate: "16000",
          channels: String(m.session.audio.channels),
          ...(m.session.audio.channels === 2 ? { roles: "customer,crew" } : {}),
          ...(opts.fixtureId ? { fixture: opts.fixtureId, fixture_offset_s: String(m.session.sourceOffsetS ?? 0) } : {}),
        });
        const headers: Record<string, string> = {};
        if (opts.ticket) q.set("ticket", await opts.ticket());
        else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
        ws = await open(`${opts.url.replace(/\/$/, "")}/hme/v1/stream?${q}`, headers, result);
        current = m.session.sessionId;
        result.sessions++;
        break;
      }
      case "audio": {
        if (!ws || m.frame.sessionId !== current) break;
        for (const chunk of wireFor.get(m.frame.sessionId)?.get(m.frame.seq) ?? []) {
          ws.send(chunk, { binary: true });
          result.messages++;
          result.bytes += chunk.length;
        }
        // Let the socket drain at max speed so we do not flood the server's buffers.
        if (speed === "max" && ws.bufferedAmount > 256 * 1024) await sleep(5);
        break;
      }
      case "control":
        if (ws && m.event.sessionId === current) {
          ws.send(JSON.stringify({ type: m.event.type, at: m.event.at }));
          result.messages++;
        }
        break;
      case "session_close":
        if (ws && m.sessionId === current) {
          await closeSocket(ws);
          ws = null;
          current = null;
        }
        break;
      default:
        break;
    }
  }
  if (ws) await closeSocket(ws);
  return result;
}

function open(url: string, headers: Record<string, string>, result: WsReplayResult): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`endpoint refused the connection: HTTP ${res.statusCode}`)));
    ws.once("error", reject);
    ws.on("close", (code, reason) => result.closes.push({ code, reason: reason.toString() }));
  });
}

/** Wait until everything sent has left, then close and wait for the close handshake. */
async function closeSocket(ws: WebSocket): Promise<void> {
  while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 0) await realSleep(5);
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
    ws.close(1000, "replay done");
    setTimeout(resolve, 3000).unref?.();
  });
}

export interface RawReplayOptions {
  url: string;
  token?: string;
  ticket?: () => string | Promise<string>;
  /** "max" (default) or a multiple of the original pace (1 = as received). */
  speed?: number | "max";
}

/**
 * Replay a captured session byte for byte: same declared format, same
 * messages in the same order (binary stays binary, text stays text).
 */
export async function replayRawOverWs(data: DataStore, sessionId: string, opts: RawReplayOptions): Promise<WsReplayResult & { incomplete: boolean }> {
  const { manifest, messages, incomplete } = await readRawSession(data, sessionId);
  const f = manifest.format;
  const q = new URLSearchParams({ lane: manifest.lane_id, codec: f.codec, rate: String(f.sampleRate), channels: String(f.channels), ...(f.roles ? { roles: f.roles.join(",") } : {}) });
  const headers: Record<string, string> = {};
  if (opts.ticket) q.set("ticket", await opts.ticket());
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const result: WsReplayResult = { sessions: 1, messages: 0, bytes: 0, closes: [] };
  const ws = await open(`${opts.url.replace(/\/$/, "")}/hme/v1/stream?${q}`, headers, result);
  const speed = opts.speed ?? "max";
  const t0 = Date.parse(messages[0]?.receivedAt ?? manifest.opened_at);
  const wallStart = Date.now();
  for (const m of messages) {
    if (speed !== "max") {
      const wait = wallStart + (Date.parse(m.receivedAt) - t0) / speed - Date.now();
      if (wait > 0) await realSleep(wait);
    } else if (ws.bufferedAmount > 256 * 1024) await realSleep(5);
    ws.send(m.kind === "binary" ? m.bytes : new TextDecoder().decode(m.bytes), { binary: m.kind === "binary" });
    result.messages++;
    result.bytes += m.bytes.length;
  }
  await closeSocket(ws);
  return { ...result, incomplete };
}
