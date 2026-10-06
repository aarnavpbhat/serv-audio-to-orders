/** The conversation tracker with a fake clock: every transition in the plan's table. */
import { describe, expect, it } from "vitest";
import { getConfig } from "@serv/config";
import type { Utterance } from "../schemas";
import { ConversationTracker, type TrackerAction } from "./tracker";

const BASE = Date.parse("2026-10-03T18:40:00Z");
const at = (s: number) => new Date(BASE + s * 1000).toISOString();
let n = 0;
function utt(speaker: "crew" | "customer", text: string, start: number, dur = 2): Utterance {
  n++;
  return { id: `u${n}`, speaker, text, start_s: start, end_s: start + dur, start_utc: at(start), end_utc: at(start + dur), confidence: 1, words: [] };
}

const cfg = getConfig();
const tracker = () =>
  new ConversationTracker({
    closeSettleS: 3,
    idleTimeoutS: 45,
    reconnectGraceS: 180,
    reopenWindowS: 20,
    maxConversationS: 360,
    segment: { ...cfg.segment, lowAudioQualityMeanConf: cfg.lowAudioQualityMeanConf },
  });
const types = (a: TrackerAction[]) => a.map((x) => (x.type === "finalize" ? `finalize:${x.trigger}` : x.type));

/** Greeting, an order, and the crew's close, ending at 12 s. */
function ordered(t: ConversationTracker): TrackerAction[] {
  return [
    ...t.onUtterance(utt("crew", "Welcome, what can I get for you today?", 0)),
    ...t.onUtterance(utt("customer", "Can I get a cheeseburger?", 3)),
    ...t.onUtterance(utt("crew", "Your total is $2.99, please pull forward.", 10)),
  ];
}

describe("ConversationTracker", () => {
  it("opens on the greeting, closes on the end cue, finalizes after the settle time", () => {
    const t = tracker();
    expect(types(ordered(t))).toEqual(["open"]);
    expect(t.status.state).toBe("CLOSING");
    expect(t.onTick(at(14.9))).toEqual([]);
    const done = t.onTick(at(15.1));
    expect(types(done)).toEqual(["finalize:settled"]);
    const f = done[0];
    expect(f?.type === "finalize" && f.utteranceIds).toHaveLength(3);
    expect(t.status.state).toBe("FINALIZED");
  });

  it("a customer 'thanks' keeps it closing; more ordering goes back to active", () => {
    const t = tracker();
    ordered(t);
    t.onUtterance(utt("customer", "Thanks!", 12.5, 0.5));
    expect(t.status.state).toBe("CLOSING");
    t.onUtterance(utt("customer", "Actually, can I also get a large fries?", 13.5));
    expect(t.status.state).toBe("ACTIVE");
    expect(t.onTick(at(30))).toEqual([]);
  });

  it("a customer 'thanks' after finalizing stays with that car and opens nothing", () => {
    const t = tracker();
    ordered(t);
    t.onTick(at(15.1));
    expect(t.status.state).toBe("FINALIZED");
    expect(t.onUtterance(utt("customer", "Thank you, bye!", 16, 1))).toEqual([]);
    expect(t.status.state).toBe("FINALIZED");
    expect(t.decisions.at(-1)?.trigger).toBe("ack_after_finalize");
    // A real late addition still reopens.
    expect(types(t.onUtterance(utt("customer", "Oh wait, can I add a water?", 18)))).toEqual(["reopen"]);
  });

  it("customer 'that's it' plus a crew answer closes", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "A cheeseburger, that's it.", 3));
    t.onUtterance(utt("crew", "Okay.", 6, 1));
    expect(t.status.state).toBe("CLOSING");
  });

  it("the next car's greeting during closing finalizes at once and opens a new conversation", () => {
    const t = tracker();
    ordered(t);
    const a = t.onUtterance(utt("crew", "Welcome to Sandbox Burger, what can I get for you?", 12.5));
    expect(types(a)).toEqual(["finalize:next_car", "open"]);
  });

  it("vehicle_departed finalizes immediately", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "Can I get a ten piece nuggets?", 3));
    const a = t.onControl({ type: "vehicle_departed", at: at(8) });
    expect(types(a)).toEqual(["finalize:vehicle_departed"]);
    const f = a[0];
    expect(f?.type === "finalize" && f.vehicle[0]?.event).toBe("vehicle_departed");
  });

  it("vehicle_arrived opens the conversation when idle", () => {
    const t = tracker();
    expect(types(t.onControl({ type: "vehicle_arrived", at: at(0) }))).toEqual(["open"]);
    expect(t.status.state).toBe("ACTIVE");
  });

  it("no speech for the idle timeout finishes the conversation with silence as context", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "Can I get a cheeseburger?", 3));
    expect(t.onTick(at(49))).toEqual([]);
    const a = t.onTick(at(50.1));
    expect(types(a)).toEqual(["finalize:idle_timeout"]);
    const f = a[0];
    expect(f?.type === "finalize" && f.silence[0]).toMatchObject({ type: "silence", duration_s: 45, context_only: true });
  });

  it("D10: a pause closes the conversation but only as context", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "Can I get a cheeseburger?", 3));
    const a = t.onControl({ type: "stream_paused", at: at(7) });
    expect(types(a)).toEqual(["finalize:stream_paused"]);
    const f = a[0];
    expect(f?.type === "finalize" && f.stream[0]).toMatchObject({ event: "stream_paused", context_only: true });
  });

  it("a disconnect holds the conversation; a reconnect continues it with stream_gap", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "Can I get a cheeseburger?", 3));
    t.onControl({ type: "disconnect", at: at(6) });
    expect(t.onTick(at(100))).toEqual([]); // no idle timeout while held
    t.onControl({ type: "reconnect", at: at(110) });
    t.onUtterance(utt("crew", "Sorry, you cut out. Your total is $2.99, pull forward.", 111));
    const a = t.onTick(at(120));
    expect(types(a)).toEqual(["finalize:settled"]);
    const f = a[0];
    expect(f?.type === "finalize" && f.flags).toEqual(["stream_gap"]);
  });

  it("no reconnect within the grace window finalizes with stream_interrupted", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "Can I get a cheeseburger?", 3));
    t.onControl({ type: "disconnect", at: at(6) });
    const a = t.onTick(at(187));
    expect(types(a)).toEqual(["finalize:grace_expired"]);
    const f = a[0];
    expect(f?.type === "finalize" && [f.flags, f.at]).toEqual([["stream_interrupted"], at(186)]);
  });

  it("D5: the same customer within the reopen window reopens the order", () => {
    const t = tracker();
    ordered(t);
    t.onTick(at(16));
    const a = t.onUtterance(utt("customer", "Oh wait, can I add a water?", 20));
    expect(types(a)).toEqual(["reopen"]);
    t.onUtterance(utt("crew", "Sure, added a water. Pull forward.", 23));
    const b = t.onTick(at(30));
    expect(types(b)).toEqual(["finalize:settled"]);
    const f = b[0];
    expect(f?.type === "finalize" && [f.reopened, f.utteranceIds.length]).toEqual([true, 5]);
  });

  it("no reopen after the window, after a new car arrives, or when the speaker greets", () => {
    const late = tracker();
    ordered(late);
    late.onTick(at(16));
    expect(types(late.onUtterance(utt("customer", "Can I add a water?", 40)))).toEqual(["open"]);

    const arrived = tracker();
    ordered(arrived);
    arrived.onTick(at(16));
    arrived.onControl({ type: "vehicle_arrived", at: at(17) });
    expect(types(arrived.onUtterance(utt("customer", "Can I get two hamburgers?", 19)))).toEqual([]);
    expect(arrived.status.state).toBe("ACTIVE");

    const greet = tracker();
    ordered(greet);
    greet.onTick(at(16));
    expect(types(greet.onUtterance(utt("customer", "Hi, can I get a shake?", 19)))).toEqual(["open"]);
  });

  it("a vehicle event in the reopen window is late evidence for the finished order", () => {
    const t = tracker();
    ordered(t);
    t.onTick(at(16));
    const a = t.onControl({ type: "vehicle_departed", at: at(17) });
    expect(a).toEqual([{ type: "late_evidence", conversationId: "conv_1", at: at(17), vehicle: [{ type: "vehicle_event", event: "vehicle_departed", at: at(17) }] }]);
  });

  it("a gray-zone gap asks the judge; its answer decides, and no answer falls back to the rules", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t.onUtterance(utt("customer", "Can I get a cheeseburger?", 3));
    const next = utt("customer", "Can I get a large Coke?", 17);
    const q = t.needsJudge(next);
    expect(q?.score).toBeGreaterThanOrEqual(0.35);
    expect(types(t.onUtterance(next, { newCar: false }))).toEqual([]);
    const t2 = tracker();
    t2.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    t2.onUtterance(utt("customer", "Can I get a cheeseburger?", 3));
    expect(types(t2.onUtterance(utt("customer", "Can I get a large Coke?", 17), { newCar: true }))).toEqual(["finalize:next_car", "open"]);
  });

  it("a conversation longer than six minutes is finalized", () => {
    const t = tracker();
    t.onUtterance(utt("crew", "Welcome, what can I get for you?", 0));
    for (let s = 3; s < 361; s += 30) t.onUtterance(utt("customer", "And another cheeseburger.", s));
    expect(types(t.onTick(at(361)))).toEqual(["finalize:max_length"]);
  });

  it("logs every decision with its trigger and signals", () => {
    const t = tracker();
    ordered(t);
    t.onTick(at(16));
    expect(t.decisions.map((d) => `${d.from}->${d.to}:${d.trigger}`)).toEqual(["IDLE->ACTIVE:crew_greeting", "ACTIVE->CLOSING:crew_end_cue", "CLOSING->FINALIZED:settled"]);
  });

  it("any order of control events, silence and speech is handled without an error (monkey)", () => {
    const controls = ["vehicle_arrived", "vehicle_departed", "stream_paused", "stream_resumed", "disconnect", "reconnect"] as const;
    const lines = ["Welcome, what can I get you?", "A cheeseburger please.", "Your total is $2.99, pull forward.", "Thanks!", ""];
    for (let seed = 1; seed <= 50; seed++) {
      let x = seed;
      const random = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
      const t = tracker();
      let now = 0;
      const opened = new Set<string>();
      const finalized: string[] = [];
      for (let step = 0; step < 200; step++) {
        now += random() * 20;
        const r = random();
        const actions =
          r < 0.5
            ? t.onControl({ type: controls[Math.floor(random() * controls.length)] as (typeof controls)[number], at: at(now) })
            : r < 0.8
              ? t.onTick(at(now))
              : t.onUtterance(utt(random() < 0.5 ? "crew" : "customer", lines[Math.floor(random() * lines.length)] as string, now, 1));
        for (const a of actions) {
          if (a.type === "open") opened.add(a.conversationId);
          if (a.type === "finalize") finalized.push(a.conversationId);
        }
        expect(["IDLE", "ACTIVE", "CLOSING", "FINALIZED"]).toContain(t.status.state);
      }
      // Only a conversation that was opened is ever finalized.
      for (const id of finalized) expect(opened.has(id)).toBe(true);
    }
  });
});
