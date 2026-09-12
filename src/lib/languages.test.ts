import { describe, expect, it } from "vitest";
import { LANGUAGES, labelForCode } from "./languages";

describe("languages", () => {
  it("covers exactly the four supported codes", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "am", "ti", "om"]);
  });

  it("uses the Tigrigna spelling", () => {
    expect(labelForCode("ti")).toBe("Tigrigna");
  });

  it("falls back to the raw code when unknown", () => {
    expect(labelForCode("zz")).toBe("zz");
  });
});
