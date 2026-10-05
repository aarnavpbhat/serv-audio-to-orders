import { describe, expect, it, vi } from "vitest";

const { getRunDetail } = vi.hoisted(() => ({ getRunDetail: vi.fn() }));
vi.mock("@/lib/data", () => ({ getRunDetail }));

import { GET } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET /api/runs/[id]", () => {
  it("returns the run", async () => {
    getRunDetail.mockReturnValue({ id: "run_1", status: "completed" });
    const res = await GET(new Request("http://test/api/runs/run_1"), ctx("run_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "run_1", status: "completed" });
  });

  it("answers an unknown run with the standard 404 error shape", async () => {
    getRunDetail.mockReturnValue(undefined);
    const res = await GET(new Request("http://test/api/runs/nope"), ctx("nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: expect.stringContaining("Run") } });
  });
});
