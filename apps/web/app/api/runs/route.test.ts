import { describe, expect, it, vi } from "vitest";

const { enqueueRun, insertRun } = vi.hoisted(() => ({ enqueueRun: vi.fn(), insertRun: vi.fn() }));
vi.mock("@/lib/jobs", () => ({ enqueueRun }));
vi.mock("@/lib/data", () => ({ db: () => ({}), listRunSummaries: () => [] }));
vi.mock("@/lib/fixtures", () => ({ fixturePath: (f: string) => (f === "01_simple.mono.clean.mp3" ? "/fixtures/01_simple.mono.clean.mp3" : null) }));
vi.mock("@serv/config", () => ({
  getConfig: () => ({ paths: { dataDir: "/tmp" }, deepgramApiKey: null, geminiApiKey: null }),
  parseChannelMap: () => null,
}));
vi.mock("@serv/pipeline", () => ({
  defaultTranscriber: () => "script",
  defaultExtractor: () => "fuzzy",
  newId: () => "run_test",
  store: { insertRun },
}));

import { POST } from "./route";

const post = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return POST(new Request("http://test/api/runs", { method: "POST", body: form }));
};

describe("POST /api/runs", () => {
  it("queues a fixture run", async () => {
    const res = await post({ fixture: "01_simple.mono.clean.mp3", transcriber: "script", extractor: "fuzzy" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ run_id: "run_test" });
    expect(enqueueRun).toHaveBeenCalledOnce();
  });

  it("rejects a request with no audio", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "BAD_REQUEST", message: "Upload an MP3 or pick a fixture" });
  });

  it("refuses a provider whose key is missing", async () => {
    const res = await post({ fixture: "01_simple.mono.clean.mp3", transcriber: "deepgram" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("DEEPGRAM_API_KEY is not set");
    expect(enqueueRun).not.toHaveBeenCalled();
  });
});
