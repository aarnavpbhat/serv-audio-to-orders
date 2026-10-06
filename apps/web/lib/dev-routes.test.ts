import { describe, expect, it } from "vitest";
import { isLocalHeaders } from "./dev-routes";

const h = (o: Record<string, string>) => new Headers(o);

describe("isLocalHeaders", () => {
  it("accepts a local host with no forwarding, or the loopback address Next.js adds itself", () => {
    expect(isLocalHeaders(h({ host: "localhost:3000" }))).toBe(true);
    expect(isLocalHeaders(h({ host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1" }))).toBe(true);
    expect(isLocalHeaders(h({ host: "[::1]:3000", "x-forwarded-for": "::ffff:127.0.0.1" }))).toBe(true);
  });

  it("refuses another host, or any forwarded hop that is not loopback", () => {
    expect(isLocalHeaders(h({ host: "192.168.1.20:3000" }))).toBe(false);
    expect(isLocalHeaders(h({ host: "localhost:3000", "x-forwarded-for": "10.0.0.1" }))).toBe(false);
    expect(isLocalHeaders(h({ host: "localhost:3000", "x-forwarded-for": "203.0.113.9, 127.0.0.1" }))).toBe(false);
    expect(isLocalHeaders(h({ host: "localhost:3000", "x-forwarded-for": "" }))).toBe(false);
  });
});
