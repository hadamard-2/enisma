import { describe, expect, it } from "vitest";
import { placeholderFor } from "./page-placeholder";

describe("placeholderFor", () => {
  it("says it is reading while a repair is actually in flight", () => {
    expect(placeholderFor({ sourceText: null, editedText: null, repairing: true })).toBe(
      "extracting",
    );
  });

  it("stops saying it is reading once a repair has failed", () => {
    expect(placeholderFor({ sourceText: null, editedText: null, repairing: false })).toBe(
      "emptyText",
    );
  });

  it("reports no text layer when extraction ran and found nothing", () => {
    expect(placeholderFor({ sourceText: "", editedText: null, repairing: false })).toBe(
      "noTextLayer",
    );
    expect(placeholderFor({ sourceText: "", editedText: "", repairing: false })).toBe(
      "noTextLayer",
    );
  });

  it("offers the empty-editor hint on a page the user emptied themselves", () => {
    expect(
      placeholderFor({ sourceText: "real prose", editedText: "", repairing: false }),
    ).toBe("emptyText");
  });

  it("shows no placeholder when there is text on screen", () => {
    expect(
      placeholderFor({ sourceText: "real prose", editedText: null, repairing: false }),
    ).toBe(null);
    expect(placeholderFor({ sourceText: null, editedText: "typed", repairing: true })).toBe(
      null,
    );
    expect(placeholderFor({ sourceText: "", editedText: "typed", repairing: false })).toBe(
      null,
    );
  });

  it("never claims to be reading a page that was extracted", () => {
    expect(placeholderFor({ sourceText: "", editedText: "", repairing: true })).toBe(
      "noTextLayer",
    );
    expect(placeholderFor({ sourceText: "prose", editedText: "", repairing: true })).toBe(
      "emptyText",
    );
  });
});
