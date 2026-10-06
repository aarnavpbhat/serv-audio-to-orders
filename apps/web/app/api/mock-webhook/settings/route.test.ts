import { describe, expect, it, vi } from "vitest";

const { setMockSettings } = vi.hoisted(() => ({ setMockSettings: vi.fn() }));
vi.mock("@serv/pipeline", () => ({ store: { setMockSettings } }));
vi.mock("@/lib/data", () => ({ db: () => ({}) }));

import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://test/api/mock-webhook/settings", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/mock-webhook/settings", () => {
  it("stores a valid failure mode", async () => {
    const res = await post({ mode: "rate_limit_429", remaining: 2, retry_after_s: 4 });
    expect(res.status).toBe(200);
    expect(setMockSettings).toHaveBeenCalledWith({}, { mode: "rate_limit_429", remaining: 2, retry_after_s: 4 });
  });

  it("rejects an unknown mode with the standard 400 error shape", async () => {
    const res = await post({ mode: "explode" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
    expect(setMockSettings).not.toHaveBeenCalled();
  });
});
