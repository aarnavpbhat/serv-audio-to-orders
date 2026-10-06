import { describe, expect, it, vi } from "vitest";

const { resendDelivery } = vi.hoisted(() => ({ resendDelivery: vi.fn() }));
vi.mock("@/lib/jobs", () => ({ resendDelivery }));

import { POST } from "./route";

const call = (id: string) => POST(new Request(`http://test/api/deliveries/${id}/resend`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe("POST /api/deliveries/[id]/resend", () => {
  it("returns the delivery after a resend", async () => {
    resendDelivery.mockResolvedValue({ webhook_id: "w1", status: "delivered" });
    const res = await call("w1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "delivered" });
  });

  it("maps an unknown delivery to 404", async () => {
    resendDelivery.mockRejectedValue(new Error("No delivery w9"));
    const res = await call("w9");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("maps a delivery in flight to 409", async () => {
    resendDelivery.mockRejectedValue(new Error("w1 is being delivered right now"));
    const res = await call("w1");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });
});
