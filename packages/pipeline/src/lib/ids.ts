import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time + 80-bit randomness, Crockford base32, sortable by creation time. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

export const newId = (prefix: string): string => `${prefix}_${ulid()}`;

/** Deterministic ids for tests and fixtures. */
export function sequentialIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}_${String(++n).padStart(4, "0")}`;
}
