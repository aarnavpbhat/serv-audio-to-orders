import { beforeEach, describe, expect, it, vi } from "vitest";

let devRoutes = true;
vi.mock("@serv/config", () => ({ getConfig: () => ({ enableDevRoutes: devRoutes, ingest: { publicUrl: "ws://127.0.0.1:8787" } }) }));
vi.mock("@serv/pipeline", () => ({ isSafeId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) }));
const fetchMock = vi.fn(async () => Response.json({ stopped: true, mode: "end" }));
vi.stubGlobal("fetch", fetchMock);

const { POST } = await import("./route");
const call = (id: string, body: unknown, host = "localhost:3000", headers: Record<string, string> = {}) =>
  POST(new Request(`http://${host}/api/sessions/${id}/stop`, { method: "POST", headers: { host, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("POST /api/sessions/:id/stop", () => {
  beforeEach(() => {
    devRoutes = true;
    fetchMock.mockClear();
  });

  it("forwards the stop to the feed service's local dev route", async () => {
    const res = await call("ses_1", { mode: "end" });
    expect(await res.json()).toEqual({ stopped: true, mode: "end" });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8787/dev/sessions/ses_1/stop", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "end" }) }));
  });

  it("refuses a bad mode or id, non-JSON, non-local requests, and is a 404 without dev routes", async () => {
    expect((await call("ses_1", { mode: "boom" })).status).toBe(400);
    expect((await call("../x", { mode: "end" })).status).toBe(400);
    expect((await call("ses_1", { mode: "end" }, "localhost:3000", { "content-type": "text/plain" })).status).toBe(400);
    expect((await call("ses_1", { mode: "end" }, "192.168.1.20:3000")).status).toBe(404);
    devRoutes = false;
    expect((await call("ses_1", { mode: "end" })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when the feed service is down (503)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await call("ses_1", { mode: "discard" })).status).toBe(503);
  });
});
