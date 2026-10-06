import { describe, expect, it } from "vitest";
import { assertSafeId, isSafeId } from "./safe-id";

describe("safe ids", () => {
  it("accepts plain ids and rejects anything path-like", () => {
    for (const ok of ["store_demo_001", "lane-1", "ses_01M47AKE9WG9ENNPT98R0Z0GNR", "A"]) expect(isSafeId(ok)).toBe(true);
    for (const bad of ["", "../etc", "a/b", "a\\b", ".hidden", "-flag", "x".repeat(65), "lane 1", "lane\n1", "café"]) expect(isSafeId(bad)).toBe(false);
    expect(() => assertSafeId("store", "../../x")).toThrow(/not allowed/);
  });
});
