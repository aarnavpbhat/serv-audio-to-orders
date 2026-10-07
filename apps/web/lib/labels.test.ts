import { describe, expect, it } from "vitest";
import { sttLabel } from "./labels";

describe("sttLabel", () => {
  it("names the model in plain words, with how it ran", () => {
    expect(sttLabel("deepgram/nova-3-live")).toBe("Deepgram Nova-3 (live)");
    expect(sttLabel("deepgram/nova-3")).toBe("Deepgram Nova-3 (file)");
    expect(sttLabel("script/ground-truth")).toBe("Script (ground truth)");
    expect(sttLabel("other/x")).toBe("other/x");
  });
});
