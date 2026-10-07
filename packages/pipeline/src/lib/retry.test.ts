import { describe, expect, it } from "vitest";
import { errorStatus, isRetryableError, withRetry } from "./retry";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe("withRetry", () => {
  it("retries a transient failure, then returns the result", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw httpError(503);
        return "ok";
      },
      { maxRetries: 3, initialDelay: 1, maxDelay: 2 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry when retryOn says no", async () => {
    let calls = 0;
    const fail = withRetry(
      async () => {
        calls++;
        throw httpError(400);
      },
      { maxRetries: 3, initialDelay: 1 },
    );
    await expect(fail).rejects.toThrow("HTTP 400");
    expect(calls).toBe(1);
  });

  it("waits the server-provided delay from delayHint instead of the backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        if (calls++ === 0) throw httpError(429);
        return true;
      },
      { maxRetries: 1, initialDelay: 5000, delayHint: () => 5, onRetry: (_e, _n, ms) => delays.push(ms) },
    );
    expect(delays).toEqual([5]);
  });

  it("gives up after maxRetries + 1 attempts", async () => {
    let calls = 0;
    const fail = withRetry(
      async () => {
        calls++;
        throw httpError(500);
      },
      { maxRetries: 2, initialDelay: 1, maxDelay: 1 },
    );
    await expect(fail).rejects.toThrow("HTTP 500");
    expect(calls).toBe(3);
  });
});

describe("error inspection", () => {
  it("reads status from SDK error shapes and the message", () => {
    expect(errorStatus(httpError(429))).toBe(429);
    expect(errorStatus({ statusCode: 502 })).toBe(502);
    expect(errorStatus({ response: { status: 503 } })).toBe(503);
    expect(errorStatus(new Error("got 500 from upstream"))).toBe(500);
    expect(errorStatus(new Error("bad input"))).toBeNull();
  });

  it("treats 429, 5xx and network errors as retryable, other 4xx as not", () => {
    expect(isRetryableError(httpError(429))).toBe(true);
    expect(isRetryableError(httpError(503))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(httpError(400))).toBe(false);
  });
});
