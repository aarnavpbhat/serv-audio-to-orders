/** Live view feed: what the lane reports while it runs, and the live_events hand-off. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, testEngine } from "../test-helpers";
import { appendLive, liveAfter, liveRecent, toLive } from "./live-feed";
import type { LaneUpdate } from "./lane";
import { replayFile } from "./replay";
import { ScriptStreamingTranscriber } from "./script-transcriber";

describe("live feed", () => {
  it("a replay reports sessions, lines, tracker status, the draft order, the order and its delivery state", async () => {
    const engine = testEngine();
    const updates: LaneUpdate[] = [];
    await replayFile(engine, path.join(repoRoot, "fixtures/audio/02_combo_slot.mono.clean.mp3"), { transcriber: new ScriptStreamingTranscriber(), deliver: true, onUpdate: (_l, u) => updates.push(u) });
    await new Promise((r) => setTimeout(r, 50));
    const types = new Set(updates.map((u) => u.type));
    for (const t of ["session", "utterance", "status", "draft", "tracker", "order", "delivery"]) expect(types.has(t as LaneUpdate["type"])).toBe(true);
    const states = updates.flatMap((u) => (u.type === "status" ? [u.status.state] : []));
    expect(states).toEqual(expect.arrayContaining(["IDLE", "ACTIVE", "CLOSING", "FINALIZED"]));
    // The keyword preview grows while the conversation is open.
    const drafts = updates.flatMap((u) => (u.type === "draft" && u.conversationId ? [u.lines.length] : []));
    expect(Math.max(...drafts)).toBeGreaterThan(0);
    // Status is only sent when it changes.
    const statusKeys = updates.flatMap((u) => (u.type === "status" ? [JSON.stringify(u.status)] : []));
    for (let i = 1; i < statusKeys.length; i++) expect(statusKeys[i]).not.toBe(statusKeys[i - 1]);
  });

  it("strips word timings and the payload transcript; rows come back in order", () => {
    const engine = testEngine();
    const u: LaneUpdate = { type: "utterance", utterance: { id: "u1", speaker: "customer", text: "hi", start_s: 0, end_s: 1, start_utc: "x", end_utc: "y", confidence: 1, words: [{ w: "hi", start_s: 0, end_s: 1, conf: 1 }] } };
    expect(JSON.stringify(toLive(u))).not.toContain("words");
    const a = appendLive(engine.db, "s", "l", u);
    const b = appendLive(engine.db, "s", "l", { type: "interim", text: "a", sessionId: "ses" });
    expect(liveAfter(engine.db, a).map((r) => r.id)).toEqual([b]);
    expect(liveRecent(engine.db).map((r) => r.type)).toEqual(["utterance", "interim"]);
  });
});
