export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Return true to retry this error. */
  retryable: (err: unknown) => boolean;
  /** Optional server-provided delay (e.g. Retry-After) in ms. */
  delayHint?: (err: unknown) => number | null;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full-jitter exponential backoff: delay = random(0, min(max, base * 2^n)). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, rand = Math.random): number {
  return Math.round(rand() * Math.min(maxMs, baseMs * 2 ** attempt));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (attempt === opts.attempts - 1 || !opts.retryable(err)) throw err;
      const hint = opts.delayHint?.(err) ?? null;
      const delay = hint ?? backoffMs(attempt, opts.baseMs, opts.maxMs);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw last;
}

/** Pulls an HTTP status off the error shapes thrown by fetch wrappers and SDKs. */
export function errorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e.status, e.statusCode, e.response?.status, e.code]) if (typeof v === "number") return v;
  const m = /\b(429|5\d\d)\b/.exec(String((err as Error).message ?? ""));
  return m ? Number(m[1]) : null;
}

export function isTransient(err: unknown): boolean {
  const status = errorStatus(err);
  if (status !== null) return status === 408 || status === 429 || status >= 500;
  const msg = String((err as Error)?.message ?? err);
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timeout/i.test(msg);
}
