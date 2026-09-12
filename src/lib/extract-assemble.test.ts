import { describe, expect, it } from "vitest";
import { dedupeItems, toLines, type RawItem } from "./extract-assemble";

/** Terse item builder; defaults match ordinary body text in the sample textbook. */
function item(str: string, x: number, y: number, over: Partial<RawItem> = {}): RawItem {
  return { str, x, y, height: 10, hasEOL: false, ...over };
}

describe("dedupeItems", () => {
  // The sample textbook's footer drew its page number twice, so "33" arrived
  // as "3333" once items were joined.
  it("collapses an identical string drawn twice at the same position", () => {
    const items = [item("Grade 9 Biology", 57, 40), item("33", 300, 40), item("33", 300, 40)];
    expect(dedupeItems(items).map((i) => i.str)).toEqual(["Grade 9 Biology", "33"]);
  });

  it("treats a sub-pixel offset as the same position", () => {
    expect(dedupeItems([item("33", 300, 40), item("33", 300.3, 40.2)])).toHaveLength(1);
  });

  it("keeps the same string at a genuinely different position", () => {
    expect(dedupeItems([item("Fungi", 57, 600), item("Fungi", 57, 400)])).toHaveLength(2);
  });
});

describe("toLines", () => {
  // On sample page 40 the running header and the heading below it came back in
  // one hasEOL run. Grouping on hasEOL alone fuses furniture to real content,
  // where no later rule can separate them.
  it("splits a fused hasEOL run into two lines by y", () => {
    const lines = toLines([
      item("Unit Two: Characteristics and Classification of Organisms", 342, 794),
      item("2.6.3. Kingdom Fungi", 57, 780, { hasEOL: true }),
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "Unit Two: Characteristics and Classification of Organisms",
      "2.6.3. Kingdom Fungi",
    ]);
  });

  it("joins items on one line in x order, whatever order they arrive in", () => {
    const lines = toLines([item("world", 100, 600), item("hello ", 57, 600)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("hello world");
  });

  it("reports a line's left edge as the smallest x on it", () => {
    expect(toLines([item("world", 100, 600), item("hello ", 57, 600)])[0].x).toBe(57);
  });

  it("scales its tolerance with item height, so large type still groups", () => {
    const lines = toLines([
      item("Big", 57, 700, { height: 24 }),
      item(" Heading", 120, 692, { height: 24 }),
    ]);
    expect(lines).toHaveLength(1);
  });

  it("collapses runs of whitespace and drops lines with no visible text", () => {
    const lines = toLines([item("a   b", 57, 600), item("   ", 57, 580)]);
    expect(lines.map((l) => l.text)).toEqual(["a b"]);
  });
});

import { toBlocks, sortBlockLines, type Line } from "./extract-assemble";

function line(text: string, x: number, y: number): Line {
  return { text, x, y };
}

describe("toBlocks", () => {
  // Sample page 40: header at x=342, main column at x=57, sidebar at x=433.
  // pdf.js emits them as contiguous runs, so a left-edge break is enough to
  // keep them apart without interpreting the layout.
  it("breaks the stream where the left edge jumps", () => {
    const blocks = toBlocks([
      line("Unit Two: Characteristics and Classification of Organisms", 342, 794),
      line("2.6.3. Kingdom Fungi", 57, 780),
      line("Fungi are eukaryotic organisms", 57, 638),
      line("Activity 2.15: Peer", 433, 741),
      line("So far, you have studied", 411, 711),
    ]);
    expect(blocks.map((b) => b.lines.length)).toEqual([1, 2, 2]);
  });

  it("keeps an indented line in the same block as its paragraph", () => {
    const blocks = toBlocks([line("At the end of this section:", 66, 726), line("• describe fungi", 81, 709)]);
    expect(blocks).toHaveLength(1);
  });

  it("reports a block's left edge as its first line's", () => {
    expect(toBlocks([line("a", 57, 600), line("b", 81, 580)])[0].x).toBe(57);
  });

  it("returns nothing for no lines", () => {
    expect(toBlocks([])).toEqual([]);
  });
});

describe("sortBlockLines", () => {
  // Stream order is not reading order: on sample page 40 the "Objectives" box
  // label was emitted after the bullets that belong underneath it. PDF y grows
  // upward, so descending y is reading order.
  it("puts a label emitted late back above its own bullets", () => {
    const sorted = sortBlockLines({
      x: 57,
      lines: [
        line("At the end of this section:", 66, 726),
        line("• describe fungi", 81, 709),
        line("• describe the importance of fungi", 81, 694),
        line("Objectives", 65, 745),
      ],
    });
    expect(sorted.lines.map((l) => l.text)).toEqual([
      "Objectives",
      "At the end of this section:",
      "• describe fungi",
      "• describe the importance of fungi",
    ]);
  });

  it("does not mutate the block it is given", () => {
    const block = { x: 57, lines: [line("a", 57, 400), line("b", 57, 600)] };
    sortBlockLines(block);
    expect(block.lines.map((l) => l.text)).toEqual(["a", "b"]);
  });
});
