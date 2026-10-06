import { beforeEach, describe, expect, it, vi } from "vitest";

const issueTicket = vi.fn(() => ({ ticket: "tkt_x", expiresAt: Date.parse("2026-10-03T18:41:00Z") }));
let devRoutes = true;
vi.mock("@serv/config", () => ({ getConfig: () => ({ enableDevRoutes: devRoutes, ingest: { publicUrl: "ws://127.0.0.1:8787" } }) }));
vi.mock("@serv/pipeline", () => ({ isSafeId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v), issueTicket }));
vi.mock("@/lib/data", () => ({ db: () => ({}) }));

const { POST } = await import("./route");
const call = (body: unknown, host = "localhost:3000", headers: Record<string, string> = {}) =>
  POST(new Request(`http://${host}/api/dev/ingest-ticket`, { method: "POST", headers: { host, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

describe("POST /api/dev/ingest-ticket", () => {
  beforeEach(() => {
    devRoutes = true;
    issueTicket.mockClear();
  });

  it("issues a ticket bound to the store and lane", async () => {
    const res = await call({ store: "store_demo_001", lane: "lane_1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticket: "tkt_x", expires_at: "2026-10-03T18:41:00.000Z", url: "ws://127.0.0.1:8787/hme/v1/stream" });
    expect(issueTicket).toHaveBeenCalledWith({}, { storeId: "store_demo_001", laneId: "lane_1" });
  });

  it("is a 404 when dev routes are off, or the request is not local", async () => {
    devRoutes = false;
    expect((await call({ store: "s", lane: "l" })).status).toBe(404);
    devRoutes = true;
    expect((await call({ store: "s", lane: "l" }, "192.168.1.20:3000")).status).toBe(404);
    expect((await call({ store: "s", lane: "l" }, "localhost:3000", { "x-forwarded-for": "10.0.0.1" })).status).toBe(404);
    expect(issueTicket).not.toHaveBeenCalled();
  });

  it("only accepts JSON (no cross-site form posts)", async () => {
    expect((await call({ store: "s", lane: "l" }, "localhost:3000", { "content-type": "text/plain" })).status).toBe(400);
    expect((await call({ store: "s", lane: "l" }, "localhost:3000", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(400);
  });

  it("rejects ids that are not safe", async () => {
    expect((await call({ store: "../x", lane: "lane_1" })).status).toBe(400);
  });
});
