import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import { LANGUAGES, languageLabelKey } from "./languages";

describe("languages", () => {
  it("covers exactly the four supported codes", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "am", "ti", "om"]);
  });

  it("has an English catalogue entry for every code", () => {
    for (const { code } of LANGUAGES) {
      expect(en.contentLanguage).toHaveProperty(code);
    }
  });

  // Guards the spelling fix in 60dc180: the label moved into the catalogue,
  // so the assertion follows it there rather than being dropped.
  it("uses the Tigrigna spelling", () => {
    expect(en.contentLanguage.ti.message).toBe("Tigrigna");
  });

  it("builds the catalogue key from the code", () => {
    expect(languageLabelKey("ti")).toBe("contentLanguage.ti");
  });
});
