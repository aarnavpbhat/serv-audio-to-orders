/**
 * IDs that end up in file paths (store, lane, session, order) are checked
 * against a strict pattern first, so "../" or a slash can never write outside .data/.
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class UnsafeIdError extends Error {
  constructor(kind: string, value: string) {
    super(`${kind} "${value.slice(0, 80)}" is not allowed: use letters, digits, "_" or "-" (1 to 64 characters, starting with a letter or digit)`);
    this.name = "UnsafeIdError";
  }
}

export const isSafeId = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v);

export function assertSafeId(kind: string, v: unknown): string {
  if (!isSafeId(v)) throw new UnsafeIdError(kind, String(v));
  return v;
}
