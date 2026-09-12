import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractFromDocument, toRawItems } from "./extract";

/**
 * Opens the fixture with pdf.js's legacy build, which is the one that runs
 * under Node. The app itself imports the default build; the split between
 * `extract.ts` and `extract-open.ts` is what lets this test exercise the
 * mapping without needing the browser entry point.
 *
 * The fixture itself is generated, not a copy of the Rust fixture: its three
 * pages carry per-page-distinct text ("Alpha fixture page", "Bravo fixture
 * page", "Charlie fixture page") rather than text that differs only by an
 * incrementing page number. A line that varies solely by digit run is exactly
 * what `extract-assemble.ts`'s furniture-detection heuristic treats as a
 * repeating header/footer and strips from every page — which is correct
 * behaviour for that module, but made the original digit-only fixture
 * indistinguishable from furniture. Regenerate it from the committed
 * `src/lib/__fixtures__/three-pages.ps` with:
 *
 *   gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
 *     -sOutputFile=src/lib/__fixtures__/three-pages.pdf \
 *     src/lib/__fixtures__/three-pages.ps
 */
async function fixtureDocument() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const path = fileURLToPath(new URL("./__fixtures__/three-pages.pdf", import.meta.url));
  const data = new Uint8Array(await readFile(path));
  return pdfjs.getDocument({ data }).promise;
}

describe("toRawItems", () => {
  it("reads x and y out of the transform matrix", () => {
    const items = toRawItems([
      { str: "hello", transform: [1, 0, 0, 1, 57, 600], height: 10, hasEOL: false },
    ]);
    expect(items).toEqual([{ str: "hello", x: 57, y: 600, height: 10, hasEOL: false }]);
  });

  // TextMarkedContent entries are interleaved with text items and have no str.
  it("drops entries with no string", () => {
    expect(toRawItems([{ type: "beginMarkedContent" }])).toEqual([]);
  });

  it("drops empty strings", () => {
    expect(toRawItems([{ str: "", transform: [1, 0, 0, 1, 0, 0], height: 10 }])).toEqual([]);
  });

  it("drops an entry with no usable transform", () => {
    expect(toRawItems([{ str: "hello", height: 10 }])).toEqual([]);
  });

  it("substitutes a default height when one is missing or zero", () => {
    const items = toRawItems([{ str: "hello", transform: [1, 0, 0, 1, 0, 0], height: 0 }]);
    expect(items[0].height).toBeGreaterThan(0);
  });
});

describe("extractFromDocument", () => {
  it("returns one string per page of the real document", async () => {
    const result = await extractFromDocument(await fixtureDocument());
    expect(result.pageTexts).toHaveLength(3);
    expect(result.pageTexts[0]).toContain("Alpha fixture page");
    expect(result.pageTexts[2]).toContain("Charlie fixture page");
  });

  it("counts the fixture's sparse pages as empty and so calls it scanned", async () => {
    // Each fixture page holds 16-19 non-whitespace characters, well under the 50-character floor.
    const result = await extractFromDocument(await fixtureDocument());
    expect(result.emptyPages).toBe(3);
    expect(result.looksScanned).toBe(true);
  });
});
