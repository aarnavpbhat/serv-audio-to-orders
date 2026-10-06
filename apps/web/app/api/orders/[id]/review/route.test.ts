import { beforeEach, describe, expect, it, vi } from "vitest";

class ReviewConflictError extends Error {}
const resolveReview = vi.fn();
let devRoutes = true;
vi.mock("@serv/config", () => ({ getConfig: () => ({ enableDevRoutes: devRoutes }) }));
vi.mock("@serv/pipeline", () => ({
  isSafeId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v),
  createEngine: () => ({}),
  resolveReview,
  ReviewConflictError,
  ReviewResolution: {
    safeParse: (v: { author?: string } | null) => (v?.author ? { success: true, data: v } : { success: false, error: { issues: [{ path: ["author"], message: "required" }] } }),
  },
}));

const { POST } = await import("./route");
const body = { version: 1, items: {}, status: "completed", author: "tester" };
const call = (id: string, b: unknown = body, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost:3000/api/orders/${id}/review`, { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(b) }), { params: Promise.resolve({ id }) });

describe("POST /api/orders/:id/review", () => {
  beforeEach(() => {
    devRoutes = true;
    resolveReview.mockReset();
  });

  it("resolves and returns the new version", async () => {
    resolveReview.mockResolvedValue({ order_id: "ord_1", order_version: 2, status: "completed", review: { required: false, reasons: [] } });
    const res = await call("ord_1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { order_version: number }).order_version).toBe(2);
  });

  it("a stale version is a 409; dev routes off is a 404; bad input is a 400", async () => {
    resolveReview.mockRejectedValue(new ReviewConflictError("Order ord_1 is at version 3 now"));
    expect((await call("ord_1")).status).toBe(409);
    expect((await call("ord_1", { ...body, author: "" })).status).toBe(400);
    expect((await call("../x")).status).toBe(404);
    devRoutes = false;
    expect((await call("ord_1")).status).toBe(404);
  });
});
