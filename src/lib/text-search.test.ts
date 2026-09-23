import { describe, expect, it } from "vitest";
import { findAll, searchPages, snippet } from "./text-search";

describe("findAll", () => {
  it("finds every occurrence, ignoring case", () => {
    expect(findAll("Cell, cell and CELL", "cell")).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 },
      { start: 15, end: 19 },
    ]);
  });

  it("does not overlap matches", () => {
    expect(findAll("aaaa", "aa")).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  it("finds nothing for an empty query", () => {
    expect(findAll("anything", "")).toEqual([]);
  });

  it("works on Ge'ez text", () => {
    expect(findAll("ሕዋስ እና ሕዋስ", "ሕዋስ")).toEqual([{ start: 0, end: 3 }, { start: 7, end: 10 }]);
  });

  it("keeps offsets exact past a character whose lowercase is longer", () => {
    // "İ".toLowerCase() is two characters; folding the whole string at once
    // would shift the match after it by one.
    const text = "İ cell";
    const [m] = findAll(text, "cell");
    expect(text.slice(m!.start, m!.end)).toBe("cell");
  });
});

describe("snippet", () => {
  it("shows some context either side", () => {
    const text = "The quick brown fox jumps";
    expect(snippet(text, { start: 10, end: 15 }, 4)).toMatchObject({
      before: "…ick ",
      match: "brown",
      after: " fox…",
    });
  });

  it("stops at line breaks", () => {
    const text = "Heading\nThe cell wall\nNext";
    expect(snippet(text, { start: 12, end: 16 })).toMatchObject({
      before: "The ",
      match: "cell",
      after: " wall",
    });
  });
});

describe("searchPages", () => {
  const pages = [
    { pageNo: 1, text: "Cells are small." },
    { pageNo: 2, text: "Nothing here." },
    { pageNo: 3, text: "A cell. Another cell." },
  ];

  it("returns only pages that match, in order, with every match", () => {
    const r = searchPages(pages, "cell");
    expect(r.map((p) => p.pageNo)).toEqual([1, 3]);
    expect(r[1]!.snippets).toHaveLength(2);
  });

  it("returns nothing for a blank query", () => {
    expect(searchPages(pages, "   ")).toEqual([]);
  });
});
