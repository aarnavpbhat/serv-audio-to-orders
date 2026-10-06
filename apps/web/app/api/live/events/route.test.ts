import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { store } from "@serv/pipeline";

const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "live-route-")), "t.db");
vi.mock("@/lib/data", () => ({ db: () => store.openDb(dbPath) }));

import { GET } from "./route";

function insert(type: string, data: Record<string, unknown>): void {
  store.openDb(dbPath).prepare(`INSERT INTO live_events (at, store_id, lane_id, type, data) VALUES (?, 's1', 'lane_1', ?, ?)`).run(Date.now(), type, JSON.stringify({ type, ...data }));
}

/** Read the stream until `want` data frames arrived, then abort. */
async function read(headers: Record<string, string>, want: number): Promise<{ id: number; type: string }[]> {
  const ac = new AbortController();
  const res = GET(new Request("http://localhost/api/live/events", { headers, signal: ac.signal }));
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let text = "";
  const rows: { id: number; type: string }[] = [];
  while (rows.length < want) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
    const frames = text.split("\n\n");
    text = frames.pop() ?? "";
    for (const f of frames) {
      const data = /^data: (.*)$/m.exec(f)?.[1];
      if (data && !f.includes("event: ready")) rows.push(JSON.parse(data) as { id: number; type: string });
    }
  }
  ac.abort();
  return rows;
}

describe("GET /api/live/events", () => {
  it("sends recent rows, then new ones; a reconnect resumes after Last-Event-ID", async () => {
    insert("session", { open: true });
    insert("utterance", { utterance: { id: "u1" } });
    const first = read({}, 3);
    setTimeout(() => insert("interim", { text: "hi" }), 50);
    const rows = await first;
    expect(rows.map((r) => r.type)).toEqual(["session", "utterance", "interim"]);
    const again = await read({ "last-event-id": String(rows[1]?.id) }, 1);
    expect(again.map((r) => r.type)).toEqual(["interim"]);
  });
});
