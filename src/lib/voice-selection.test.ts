import { describe, expect, it } from "vitest";
import { reconcileVoice } from "./voice-selection";

describe("reconcileVoice", () => {
  // An empty list is ambiguous - a single-speaker language and a language
  // whose models are still downloading answer identically - so it must never
  // be read as grounds to clear a stored preference.
  it("leaves the current voice untouched and writes nothing for an empty list", () => {
    expect(reconcileVoice([], "af_heart")).toEqual({
      voice: "af_heart",
      persist: false,
    });
  });

  it("writes nothing when there is no stored voice and no list", () => {
    expect(reconcileVoice([], "")).toEqual({ voice: "", persist: false });
  });

  it("keeps the current voice when the list contains it", () => {
    expect(reconcileVoice(["af_alloy", "af_heart"], "af_heart")).toEqual({
      voice: "af_heart",
      persist: false,
    });
  });

  it("selects the first voice and persists it when the list lacks the current one", () => {
    expect(reconcileVoice(["af_alloy", "af_heart"], "am_adam")).toEqual({
      voice: "af_alloy",
      persist: true,
    });
  });

  it("selects the first voice and persists it when nothing is stored yet", () => {
    expect(reconcileVoice(["af_alloy", "af_heart"], "")).toEqual({
      voice: "af_alloy",
      persist: true,
    });
  });
});
