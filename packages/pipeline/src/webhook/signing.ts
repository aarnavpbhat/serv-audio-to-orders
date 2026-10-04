/**
 * Standard Webhooks signing (https://www.standardwebhooks.com), as used by Svix:
 *   signature = base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`))
 *   header    = "v1,<signature>" (space-separated list when rotating secrets)
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOLERANCE_S = 5 * 60;

function secretBytes(secret: string): Buffer {
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(b64, "base64");
  if (key.length < 16) throw new Error("Webhook secret is too short; expected whsec_<base64 of at least 16 bytes>");
  return key;
}

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

export interface SignedHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

export function signedHeaders(secret: string, id: string, body: string, now = Date.now()): SignedHeaders {
  const ts = Math.floor(now / 1000);
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sign(secret, id, ts, body) };
}

export type VerifyFailure = "missing_headers" | "bad_timestamp" | "timestamp_too_old" | "timestamp_too_new" | "bad_signature";

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  id?: string;
}

/** Receiver side: constant-time signature check plus replay protection on the timestamp. */
export function verify(
  secret: string,
  headers: Record<string, string | null | undefined>,
  body: string,
  now = Date.now(),
  toleranceS = TOLERANCE_S,
): VerifyResult {
  const id = headers["webhook-id"];
  const tsRaw = headers["webhook-timestamp"];
  const sigHeader = headers["webhook-signature"];
  if (!id || !tsRaw || !sigHeader) return { ok: false, reason: "missing_headers" };
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts)) return { ok: false, reason: "bad_timestamp", id };
  const nowS = Math.floor(now / 1000);
  if (nowS - ts > toleranceS) return { ok: false, reason: "timestamp_too_old", id };
  if (ts - nowS > toleranceS) return { ok: false, reason: "timestamp_too_new", id };
  const expected = Buffer.from(sign(secret, id, ts, body).slice(3), "base64");
  for (const part of sigHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, id };
  }
  return { ok: false, reason: "bad_signature", id };
}
