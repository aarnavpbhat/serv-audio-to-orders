/**
 * The endpoint HME's base station connects to: a standalone WebSocket server
 * (ws, noServer mode) in front of the lane manager.
 *
 * PLACEHOLDER path and wire format: GET /hme/v1/stream?lane=<id>&codec=<c>&rate=<hz>&channels=<n>&roles=<r,...>
 *
 * Before an upgrade is accepted: per-IP failure limit, token (or dev ticket)
 * check, lane allowed for the token, format validated, connection limits. After:
 * binary messages up to 64 KB, text up to 8 KB, one connection per store+lane
 * (the newest replaces the oldest, close 4409), at most 4 per token, ping every
 * 20 s (closed after 60 s without a pong), more than 2x the declared data rate
 * closes with 4413, and revoking a token closes its sessions with 4401.
 */
import { readFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { DB } from "../store/db";
import { isSafeId } from "../lib/safe-id";
import { TokenAuth, UNAUTHORIZED } from "../input/auth/token-auth";
import { isRevoked } from "../input/auth/tokens";
import type { IngestAuth } from "../input/auth/types";
import { HmeConnection, type ConnectionParams } from "../input/hme/connection";
import { parseFormat } from "../input/hme/handshake";
import type { SourceMessage } from "../input/types";

export const STREAM_PATH = "/hme/v1/stream";
export const MAX_BINARY_BYTES = 64 * 1024;
export const MAX_TEXT_BYTES = 8 * 1024;
export const MAX_PER_TOKEN = 4;

export const CLOSE = { revoked: 4401, replaced: 4409, rateExceeded: 4413, tooBig: 1009 } as const;

export interface IngestServerOptions {
  db: DB;
  host: string;
  port: number;
  /** Deliver every source message to the lanes. */
  onMessage: (m: SourceMessage) => void;
  /** A lane sent too much data (flag audio_rate_exceeded on its open conversation). */
  onRateExceeded?: (storeId: string, laneId: string) => void;
  /** Raw capture of every incoming message, before decoding. */
  capture?: (session: { sessionId: string; storeId: string; laneId: string }, kind: "binary" | "text", bytes: Uint8Array, receivedAt: number) => void;
  /** A connection was accepted (raw capture writes its manifest here). */
  onSessionOpened?: (session: { sessionId: string; storeId: string; laneId: string; tokenId: string; openedAt: number; format: { codec: string; sampleRate: number; channels: number; roles: string[] | null } }) => void;
  onSessionClosed?: (sessionId: string) => void;
  auth?: IngestAuth;
  allowQueryToken: boolean;
  enableDevRoutes: boolean;
  /** Dev only: let a session name a fixture id for the free script transcriber. */
  resolveFixture?: (id: string) => string | null;
  allowInsecure: boolean;
  tls?: { cert: string; key: string };
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  revocationPollMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

interface Live {
  ws: WebSocket;
  conn: HmeConnection;
  tokenId: string;
  storeId: string;
  laneId: string;
  lastPong: number;
  closing: boolean;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

export { parseFormat };

export class IngestServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly live = new Set<Live>();
  /** Connections whose socket closed but whose decoder is still draining (awaited on shutdown). */
  private readonly draining = new Set<Promise<void>>();
  private readonly auth: IngestAuth;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly opts: IngestServerOptions) {
    if (!isLocalHost(opts.host) && !opts.tls && !opts.allowInsecure) {
      throw new Error(`Refusing to listen on ${opts.host} without TLS. Set INGEST_TLS_CERT and INGEST_TLS_KEY, or ALLOW_INSECURE_WS=true for a trusted network.`);
    }
    this.auth =
      opts.auth ??
      new TokenAuth(opts.db, {
        allowQueryToken: opts.allowQueryToken,
        allowTickets: opts.enableDevRoutes,
        log: (l) => opts.log?.(l),
      });
    const handler = (_req: IncomingMessage, res: import("node:http").ServerResponse) => {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    };
    this.http = opts.tls ? createHttps({ cert: readFileSync(opts.tls.cert), key: readFileSync(opts.tls.key) }, handler) : createHttp(handler);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BINARY_BYTES });
    this.http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  get address(): { host: string; port: number } {
    const a = this.http.address();
    return { host: this.opts.host, port: typeof a === "object" && a ? a.port : this.opts.port };
  }

  get connections(): number {
    return this.live.size;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.http.listen(this.opts.port, this.opts.host, () => resolve());
      const ping = this.opts.pingIntervalMs ?? 20_000;
      const pongTimeout = this.opts.pongTimeoutMs ?? 60_000;
      this.timers.push(
        setInterval(() => {
          const now = Date.now();
          for (const l of this.live) {
            if (now - l.lastPong > pongTimeout) {
              this.opts.log?.({ event: "ingest_no_pong", session_id: l.conn.session.sessionId });
              l.ws.terminate();
            } else l.ws.ping();
          }
        }, ping),
        setInterval(() => this.checkRevoked(), this.opts.revocationPollMs ?? 2000),
      );
      for (const t of this.timers) t.unref?.();
    });
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const l of this.live) l.ws.close(1001, "server shutting down");
    await Promise.all([...this.live].map((l) => l.conn.close("remote_close")));
    // Sessions that ended just before shutdown finish decoding their last audio first.
    await Promise.all([...this.draining]);
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /** Revoked tokens close their live sessions (another process may have revoked them). */
  checkRevoked(): void {
    const ids = new Set([...this.live].map((l) => l.tokenId).filter((t) => t !== "ticket"));
    for (const id of ids) {
      if (!isRevoked(this.opts.db, id)) continue;
      for (const l of this.live) if (l.tokenId === id) l.ws.close(CLOSE.revoked, "token revoked");
    }
  }

  private reject(socket: Duplex, status: number, body: string): void {
    const text = status === 401 ? "Unauthorized" : status === 429 ? "Too Many Requests" : status === 404 ? "Not Found" : "Bad Request";
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.destroy();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://ingest.local");
    if (url.pathname !== STREAM_PATH) return this.reject(socket, 404, "not found");
    const ip = req.socket.remoteAddress ?? "unknown";
    const result = this.auth.authenticate({ ip, headers: req.headers, query: url.searchParams });
    if (!result.ok) return this.reject(socket, result.status, result.status === 401 ? UNAUTHORIZED : "too many attempts");
    const laneId = TokenAuth.laneFor(result, url.searchParams);
    if (!laneId) {
      this.opts.log?.({ event: "ingest_auth", ip, token_id: result.tokenId, result: "401", reason: "lane_not_allowed" });
      return this.reject(socket, 401, UNAUTHORIZED);
    }
    const fmt = parseFormat(url.searchParams);
    if (!fmt.ok) return this.reject(socket, 400, `bad ${fmt.reason}`);
    if (result.tokenId !== "ticket" && [...this.live].filter((l) => l.tokenId === result.tokenId).length >= MAX_PER_TOKEN) {
      this.opts.log?.({ event: "ingest_auth", ip, token_id: result.tokenId, result: "429", reason: "max_connections_per_token" });
      return this.reject(socket, 429, "too many connections for this token");
    }
    // Dev only: a fixture id (never a path) for the free script transcriber.
    let fixture: ConnectionParams["fixture"];
    const fixtureId = url.searchParams.get("fixture");
    if (fixtureId !== null) {
      const file = this.opts.enableDevRoutes && isSafeId(fixtureId) ? (this.opts.resolveFixture?.(fixtureId) ?? null) : null;
      if (!file) return this.reject(socket, 400, "bad fixture");
      const offsetS = Number(url.searchParams.get("fixture_offset_s") ?? 0);
      fixture = { path: file, offsetS: Number.isFinite(offsetS) && offsetS >= 0 ? offsetS : 0 };
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.accept(ws, {
        storeId: result.storeId,
        laneId,
        codec: fmt.codec,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        ...(fmt.roles ? { channelRoles: fmt.roles } : {}),
        ...(fixture ? { fixture } : {}),
      }, result.tokenId);
    });
  }

  private accept(ws: WebSocket, params: ConnectionParams, tokenId: string): void {
    // One connection per store+lane: the newest replaces the oldest.
    for (const l of this.live) {
      if (l.storeId === params.storeId && l.laneId === params.laneId) l.ws.close(CLOSE.replaced, "replaced by a newer connection");
    }
    let entry: Live | null = null;
    const conn = new HmeConnection(params, (m) => this.opts.onMessage(m), {
      allowTextLines: this.opts.enableDevRoutes,
      capture: (kind, bytes, at) => this.opts.capture?.({ sessionId: conn.session.sessionId, storeId: params.storeId, laneId: params.laneId }, kind, bytes, at),
      onRateExceeded: () => {
        this.opts.onRateExceeded?.(params.storeId, params.laneId);
        ws.close(CLOSE.rateExceeded, "audio rate exceeded");
      },
      onError: (e) => this.opts.log?.({ event: "ingest_decode_error", session_id: conn.session.sessionId, error: e.message.slice(0, 300) }),
    });
    entry = { ws, conn, tokenId, storeId: params.storeId, laneId: params.laneId, lastPong: Date.now(), closing: false };
    this.live.add(entry);
    this.opts.onSessionOpened?.({
      sessionId: conn.session.sessionId,
      storeId: params.storeId,
      laneId: params.laneId,
      tokenId,
      openedAt: Date.now(),
      format: { codec: params.codec, sampleRate: params.sampleRate, channels: params.channels, roles: params.channelRoles ?? null },
    });
    this.opts.log?.({ event: "ingest_session_open", session_id: conn.session.sessionId, store_id: params.storeId, lane_id: params.laneId, codec: params.codec, token_id: tokenId });

    ws.on("pong", () => {
      if (entry) entry.lastPong = Date.now();
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = toBytes(data);
      if (!isBinary) {
        if (bytes.length > MAX_TEXT_BYTES) {
          ws.close(CLOSE.tooBig, "text message too large");
          return;
        }
        conn.onText(new TextDecoder().decode(bytes));
        return;
      }
      conn.onBinary(bytes);
    });
    const done = () => {
      if (!entry || entry.closing) return;
      entry.closing = true;
      this.live.delete(entry);
      const drain = conn
        .close("remote_close")
        .then(() => this.opts.onSessionClosed?.(conn.session.sessionId))
        // Never an unhandled rejection (it would end the process), and never blocks shutdown.
        .catch((e: unknown) => this.opts.log?.({ event: "ingest_session_close_error", session_id: conn.session.sessionId, error: (e as Error).message.slice(0, 200) }));
      this.draining.add(drain);
      void drain.finally(() => this.draining.delete(drain));
      this.opts.log?.({ event: "ingest_session_close", session_id: conn.session.sessionId });
    };
    ws.on("close", done);
    ws.on("error", (e) => {
      this.opts.log?.({ event: "ingest_socket_error", session_id: conn.session.sessionId, error: e.message.slice(0, 200) });
      done();
    });
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
