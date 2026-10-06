import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RawWriter, readPart, recoverOpenParts } from "./raw-capture";

const tmp = () => mkdtempSync(path.join(tmpdir(), "raw-"));

describe("raw capture", () => {
  it("reads back every message byte for byte, in order", () => {
    const dir = tmp();
    const w = new RawWriter(dir);
    const msgs = [Uint8Array.from([1, 2, 3]), new TextEncoder().encode('{"type":"vehicle_arrived"}'), Uint8Array.from({ length: 5000 }, (_, i) => i % 256)];
    msgs.forEach((m, i) => w.write(i === 1 ? "text" : "binary", m, 1_000 + i));
    w.close();
    const back = readPart(path.join(dir, "part-00001.bin.zst"), path.join(dir, "part-00001.index.ndjson"));
    expect(back.map((b) => [...b.bytes])).toEqual(msgs.map((m) => [...m]));
    expect(back.map((b) => b.line.kind)).toEqual(["binary", "text", "binary"]);
    expect(back[1]?.line.received_at).toBe(new Date(1001).toISOString());
  });

  it("rolls a new part every 60 s or 5 MB", () => {
    const dir = tmp();
    let now = 0;
    const w = new RawWriter(dir, { now: () => now, rollBytes: 10_000 });
    w.write("binary", new Uint8Array(6000), 0);
    w.write("binary", new Uint8Array(6000), 0);
    w.write("binary", new Uint8Array(10), 0); // over 10 KB: rolls first
    now = 61_000;
    w.write("binary", new Uint8Array(10), 0); // over 60 s: rolls again
    w.close();
    expect(readdirSync(dir).filter((f) => f.endsWith(".bin.zst")).sort()).toEqual(["part-00001.bin.zst", "part-00002.bin.zst", "part-00003.bin.zst"]);
  });

  it("a part left open by a crash is finished and marked incomplete on the next start", () => {
    const dir = tmp();
    const w = new RawWriter(dir);
    w.write("binary", Uint8Array.from([9, 9]), 0);
    // no close(): the process died
    expect(recoverOpenParts(dir)).toBe(1);
    expect(existsSync(path.join(dir, "part-00001.incomplete.bin.zst"))).toBe(true);
    expect(readPart(path.join(dir, "part-00001.incomplete.bin.zst"), path.join(dir, "part-00001.incomplete.index.ndjson"))[0]?.bytes).toEqual(Uint8Array.from([9, 9]));
  });

  it("session directories only accept safe ids", () => {
    expect(() => RawWriter.sessionDir("/data/raw", "../x", "lane_1", "ses_1")).toThrow(/not allowed/);
  });
});
