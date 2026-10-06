import { describe, expect, it } from "vitest";
import { validateEvents } from "../extract/validate";
import { snrDb } from "../ingest/probe";
import { diarizationCollapsed, inferTurnRoles } from "../transcribe/roles";
import { catalog, matcher } from "../test-helpers";

const lines = (texts: string[]) => texts.map((text, i) => ({ text, start_s: i * 3, end_s: i * 3 + 2 }));

describe("roles when diarization hears one voice", () => {
  it("detects a collapsed diarization", () => {
    expect(diarizationCollapsed(["spk0", "spk0", "spk0", "spk0"])).toBe(true);
    expect(diarizationCollapsed(["spk0", "spk1", "spk0", "spk1"])).toBe(false);
  });

  it("labels a plain order from wording and turn-taking", () => {
    const roles = inferTurnRoles(
      lines([
        "Welcome to Sandbox Burger. What can I get for you today?",
        "Let me get a medium sweet tea and a medium fries.",
        "Large sweet tea and a medium fries.",
        "Anything else?",
        "No. That's it.",
        "Your total is $5.18.",
      ]),
    );
    expect(roles).toEqual(["crew", "customer", "crew", "crew", "customer", "crew"]);
  });

  it("keeps the speaker across an unfinished line and back-fills a truncated start", () => {
    expect(inferTurnRoles(lines(["Can I get a cheeseburger and a medium, uh, flourblberry", "shake?", "Sorry. What kind of shake was that?"]))).toEqual([
      "customer",
      "customer",
      "crew",
    ]);
    expect(inferTurnRoles(lines(["And a large Sprite too.", "Okay. Large Sprite.", "Anything else?"]))).toEqual(["customer", "crew", "crew"]);
  });
});

describe("snrDb", () => {
  it("measures loud windows against the quiet floor", () => {
    const noisy = Array.from({ length: 100 }, (_, i) => (i % 2 ? -20 : -30));
    const clean = Array.from({ length: 100 }, (_, i) => (i % 2 ? -20 : -70));
    expect(snrDb(noisy, 0, 10)).toBe(10);
    expect(snrDb(clean, 0, 10)).toBe(50);
    expect(snrDb(noisy, 0, 1)).toBeNull();
  });
});

describe("validateEvents", () => {
  it("accepts a modifier given as catalog_id on ADD_MODIFIER", () => {
    const base = { target_line_ref: "e1", raw_text: "ranch", quantity: null, size: null, slot: null, readback_items: null, amount: null, source_utterance_ids: [], recognition_confidence: 1, commitment_confidence: 1 };
    const out = validateEvents([{ ...base, event_id: "e2", type: "ADD_MODIFIER", catalog_id: "ranch", modifiers: [] }], [], catalog, matcher);
    expect(out.events[0]).toMatchObject({ catalog_id: null, modifiers: ["ranch"] });
    expect(out.unknownIds).toEqual([]);
  });
});
