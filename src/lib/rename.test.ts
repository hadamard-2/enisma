import { describe, expect, it } from "vitest";
import { validateTitle } from "./rename";

describe("validateTitle", () => {
  it("accepts a changed title and reports the trimmed value to save", () => {
    expect(validateTitle("  Grade 9 Biology  ", "Grade 7 Science")).toEqual({
      ok: true,
      title: "Grade 9 Biology",
    });
  });

  it("rejects an empty title", () => {
    expect(validateTitle("", "Grade 7 Science").ok).toBe(false);
  });

  // A title of only spaces would save as an untitled project the library
  // cannot show, so whitespace is not a title.
  it("rejects a title that is only whitespace", () => {
    expect(validateTitle("   ", "Grade 7 Science").ok).toBe(false);
  });

  it("rejects a title unchanged from the current one", () => {
    expect(validateTitle("Grade 7 Science", "Grade 7 Science").ok).toBe(false);
  });

  // Trimming happens before comparing, so re-saving with stray spaces is a
  // no-op rather than a write that bumps `updated_at` for nothing.
  it("treats a title differing only by surrounding space as unchanged", () => {
    expect(validateTitle("  Grade 7 Science  ", "Grade 7 Science").ok).toBe(false);
  });

  it("compares against the trimmed current title too", () => {
    expect(validateTitle("Grade 7 Science", "  Grade 7 Science  ").ok).toBe(false);
  });

  it("accepts a title that differs only in case", () => {
    expect(validateTitle("grade 7 science", "Grade 7 Science")).toEqual({
      ok: true,
      title: "grade 7 science",
    });
  });
});
