import type { OrderPayload } from "@serv/pipeline";
import { describe, expect, it } from "vitest";
import { reviewReasonText, unclearLine } from "./review-text";

const names: Record<string, string> = { shake_straw: "Strawberry Shake", shake_choc: "Chocolate Shake", coke: "Coke" };
const name = (id: string | null) => (id ? (names[id] ?? id) : "");
const line = (raw: string, ids: string[]) => ({ raw_text: raw, candidates: ids.map((catalog_id) => ({ catalog_id, score: 0.5 })) }) as unknown as OrderPayload["needs_review"][number];

describe("review reasons in plain words", () => {
  it("names what the candidates share", () => {
    expect(unclearLine(line("flurbleberry shake", ["shake_straw", "shake_choc"]), name)).toBe("We heard a shake but not which one (Strawberry Shake, Chocolate Shake).");
    expect(unclearLine(line("cola thing", ["coke"]), name)).toBe('We heard "cola thing" but could not tell which menu item it was (closest: Coke).');
    expect(unclearLine(line("zzz", []), name)).toBe('We heard "zzz" but nothing on the menu matches it.');
  });

  it("one sentence per reason", () => {
    const p = { review: { required: true, reasons: ["total_mismatch", "outcome_undetermined"] }, needs_review: [], totals: { spoken_by_crew: 9.5, computed: 7.88 } } as unknown as OrderPayload;
    expect(reviewReasonText(p, name)).toEqual(["The crew said a total of $9.50, but the items add up to $7.88.", "We could not tell how the visit ended (completed, cancelled or the car left)."]);
  });
});
