import { describe, expect, it } from "vitest";
import i18n from "./i18n";

/**
 * Guards the wiring rather than the wording: that the catalogue's
 * `{ message, context }` entries are flattened into something i18next can
 * look up, and that ICU MessageFormat is actually parsing — an unparsed
 * message renders its own braces, which is easy to miss by eye.
 */
describe("i18n", () => {
  it("resolves a plain key", () => {
    expect(i18n.t("nav.newProject")).toBe("New project");
  });

  it("does not leak the translator-facing context field", () => {
    expect(i18n.t("nav.newProject")).not.toContain("context");
  });

  it("selects ICU plural categories", () => {
    expect(i18n.t("center.stats", { words: 1, seconds: 3 })).toBe("1 word · ~3s spoken");
    expect(i18n.t("center.stats", { words: 7, seconds: 9 })).toBe("7 words · ~9s spoken");
  });

  it("interpolates named placeholders", () => {
    expect(i18n.t("pagePanel.pageAbbrev", { n: 12 })).toBe("p. 12");
    expect(i18n.t("center.loadError", { page: 4, error: "EACCES" })).toBe(
      "Could not load the text for page 4: EACCES",
    );
  });

  it("loads every offered language", async () => {
    for (const lng of ["am", "ti", "om"]) {
      await i18n.changeLanguage(lng);
      expect(i18n.t("nav.settings")).not.toBe("Settings");
    }
    await i18n.changeLanguage("en");
  });

  it("applies each language's own plural categories", async () => {
    await i18n.changeLanguage("am");
    expect(i18n.t("library.subtitle", { count: 1 })).toBe("1 ፕሮጀክት");
    expect(i18n.t("library.subtitle", { count: 7 })).toBe("7 ፕሮጀክቶች");
    await i18n.changeLanguage("en");
  });

  /**
   * Oromo drops the ICU plural wrapper (the language does not mark plural on a
   * noun quantified by a numeral), while en/am/ti keep it. Both shapes are
   * passed the same `{ count }`, so this pins the fact that i18next delegates
   * to ICU and never falls back to its own `_one`/`_other` key suffixing —
   * which would miss every unwrapped key.
   */
  it("handles wrapped and unwrapped plural shapes alike", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("library.subtitle", { count: 7 })).toBe("7 projects");
    await i18n.changeLanguage("om");
    expect(i18n.t("library.subtitle", { count: 1 })).toBe("1 pirojektii");
    expect(i18n.t("library.subtitle", { count: 7 })).toBe("7 pirojektii");
    expect(i18n.t("time.minutesAgo", { count: 5 })).toBe("daqiiqaa 5 dura");
    await i18n.changeLanguage("en");
  });

  it("keeps interface-language names in their own script", async () => {
    for (const lng of ["en", "am", "ti", "om"]) {
      await i18n.changeLanguage(lng);
      expect(i18n.t("appLanguage.am")).toBe("አማርኛ · Amharic");
    }
    await i18n.changeLanguage("en");
  });
});
