/** Outcome rules (plan D2, D10, D13): status only from evidence; review is a separate flag. */
import { describe, expect, it } from "vitest";
import { replay } from "../build/replay";
import { atS, catalog, closingSignals, cueUtt, events, ppOptions, seg } from "../test-helpers";
import { decideOutcome, emptySignals, reviewReasons, spokenCues, type OutcomeSignals } from "./outcome";
import { postprocess } from "./postprocess";

const ordered = [cueUtt("u1", "crew", "Welcome, what can I get for you?", 0), cueUtt("u2", "customer", "Can I get a cheeseburger?", 3)];
const decide = (signals: Partial<OutcomeSignals>, extra: { cancelled?: boolean; activeLines?: number } = {}) =>
  decideOutcome({
    cancelled: extra.cancelled ?? false,
    cancelEvidence: null,
    activeLines: extra.activeLines ?? 1,
    firstItemS: 3,
    signals: { ...emptySignals(), utterances: ordered, ...signals },
  });

describe("decideOutcome", () => {
  it("a crew closing cue after an item completes the order, with the cue as evidence", () => {
    const o = decide({ utterances: [...ordered, cueUtt("u3", "crew", "Your total is $4.19, see you at the window.", 8)] });
    expect(o.status).toBe("completed");
    expect(o.evidence[0]).toMatchObject({ type: "spoken_cue", kind: "closing", utterance_id: "u3", at: atS(8) });
  });

  it("customer 'that's it' counts only when the crew answers", () => {
    const done = cueUtt("u3", "customer", "That's it.", 6);
    expect(decide({ utterances: [...ordered, done] }).status).toBe("undetermined");
    expect(decide({ utterances: [...ordered, done, cueUtt("u4", "crew", "Okay.", 7)] }).status).toBe("completed");
  });

  it("a closing cue with nothing ordered proves nothing", () => {
    const o = decide({ utterances: [cueUtt("u1", "crew", "Have a good one.", 1)] }, { activeLines: 0 });
    expect(o.status).toBe("undetermined");
  });

  it("row 29: a pause after the closing cue is completed, the pause only context", () => {
    const o = decide({
      utterances: [...ordered, cueUtt("u3", "crew", "Please pull forward.", 8)],
      stream: [{ type: "stream_event", event: "stream_paused", at: atS(12) }],
    });
    expect(o.status).toBe("completed");
    expect(o.evidence.find((e) => e.type === "stream_event")).toMatchObject({ context_only: true });
  });

  it("row 30: a pause mid-order with no cue is undetermined, never completed", () => {
    const o = decide({ stream: [{ type: "stream_event", event: "stream_paused", at: atS(5) }] });
    expect(o.status).toBe("undetermined");
    expect(o.evidence.every((e) => e.context_only)).toBe(true);
  });

  it("row 33: vehicle departs before closing is abandoned with the vehicle event as evidence", () => {
    const o = decide({ vehicle: [{ type: "vehicle_event", event: "vehicle_departed", at: atS(9) }] });
    expect(o.status).toBe("abandoned");
    expect(o.evidence[0]).toMatchObject({ type: "vehicle_event", event: "vehicle_departed" });
  });

  it("a departure after the closing cue keeps completed", () => {
    const o = decide({
      utterances: [...ordered, cueUtt("u3", "crew", "Pull forward please.", 8)],
      vehicle: [{ type: "vehicle_event", event: "vehicle_departed", at: atS(14) }],
    });
    expect(o.status).toBe("completed");
  });

  it("row 34: 60 s of silence mid-order with no events is undetermined, not abandoned", () => {
    const o = decide({ silence: [{ type: "silence", at: atS(4), duration_s: 60 }] });
    expect(o.status).toBe("undetermined");
    expect(o.evidence).toEqual([{ type: "silence", at: atS(4), duration_s: 60, context_only: true }]);
  });

  it("the crew saying the car left is abandonment", () => {
    expect(decide({ utterances: [...ordered, cueUtt("u3", "crew", "Oh, they just drove off.", 9)] }).status).toBe("abandoned");
  });

  it("a mid-order greeting plus the next car's arrival is abandonment", () => {
    const o = decide({
      utterances: [...ordered, cueUtt("u3", "crew", "Welcome, what can I get for you?", 30)],
      vehicle: [{ type: "vehicle_event", event: "vehicle_arrived", at: atS(29) }],
    });
    expect(o.status).toBe("abandoned");
    expect(o.evidence.map((e) => e.kind ?? e.event)).toEqual(["next_car_greeting", "vehicle_arrived"]);
  });

  it("crew chatter never counts as a closing cue", () => {
    const chatter = { ...cueUtt("u3", "crew", "See you at the window.", 8), chatter: true };
    expect(spokenCues([...ordered, chatter], 3)).toEqual([]);
  });

  it("cancelled wins over a closing cue", () => {
    const o = decide({ utterances: [...ordered, cueUtt("u3", "crew", "No problem, have a good one.", 8)] }, { cancelled: true });
    expect(o.status).toBe("cancelled");
  });
});

describe("review", () => {
  const base = { status: "completed" as const, flags: [], unclearItems: 0, maxQuantity: 1, total: 5, cap: { maxQuantity: 10, maxTotal: 150 }, rolesLowAgreement: false };

  it("row 39: an unclear item in a finished order is completed with review.required", () => {
    const o = postprocess(replay(events([{ event_id: "e1", type: "ADD", raw_text: "sandy fluffy", recognition_confidence: 0.3 }]), catalog), seg(), ppOptions())[0]!;
    expect(o.status).toBe("completed");
    expect(o.review).toEqual({ required: true, reasons: ["unclear_items"] });
  });

  it("D13: more than 10 of one item, or a total over $150, goes to review", () => {
    expect(reviewReasons({ ...base, maxQuantity: 11 })).toEqual(["safety_cap"]);
    expect(reviewReasons({ ...base, total: 150.01 })).toEqual(["safety_cap"]);
    expect(reviewReasons({ ...base, maxQuantity: 10, total: 150 })).toEqual([]);
    const o = postprocess(replay(events([{ event_id: "e1", type: "ADD", catalog_id: "cheeseburger", quantity: 100 }]), catalog), seg({ signals: closingSignals() }), ppOptions())[0]!;
    expect(o.review.reasons).toContain("safety_cap");
  });

  it("stream and transcript flags map to review reasons; undetermined always needs review", () => {
    expect(reviewReasons({ ...base, flags: ["stream_interrupted", "audio_dropped"] })).toEqual(["stream_gap", "transcript_gap"]);
    expect(reviewReasons({ ...base, status: "undetermined" })).toEqual(["outcome_undetermined"]);
  });
});
