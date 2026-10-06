/**
 * PLACEHOLDER: HME's connect handshake is not documented. We expect the audio
 * format as query parameters on the WebSocket URL:
 *
 *   ?lane=<id>&codec=<wire codec|auto>&rate=8000..48000&channels=1|2&roles=customer,crew
 *
 * Every value is checked against a whitelist before a socket is accepted.
 */
import { isWireCodec } from "../decoders";
import type { ChannelRole } from "../types";
import type { ConnectionParams } from "./connection";

/** Validated connection format, or a reason it was refused. */
export function parseFormat(q: URLSearchParams): { ok: true; codec: ConnectionParams["codec"]; sampleRate: number; channels: number; roles?: ChannelRole[] } | { ok: false; reason: string } {
  const codec = q.get("codec") ?? "pcm_s16le";
  if (codec !== "auto" && !isWireCodec(codec)) return { ok: false, reason: "codec" };
  const sampleRate = Number(q.get("rate") ?? 16000);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) return { ok: false, reason: "rate" };
  const channels = Number(q.get("channels") ?? 1);
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) return { ok: false, reason: "channels" };
  const rolesRaw = q.get("roles");
  let roles: ChannelRole[] | undefined;
  if (rolesRaw) {
    const parts = rolesRaw.split(",");
    if (parts.length !== channels || !parts.every((r) => r === "customer" || r === "crew" || r === "mixed")) return { ok: false, reason: "roles" };
    roles = parts as ChannelRole[];
  }
  return { ok: true, codec, sampleRate, channels, ...(roles ? { roles } : {}) };
}
