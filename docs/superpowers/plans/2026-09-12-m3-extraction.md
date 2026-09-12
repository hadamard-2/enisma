# M3 Text Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill `pages.source_text` with readable prose extracted from each project's PDF text layer at import time, using pdf.js, so every imported project opens with real text in the editor.

**Architecture:** Extraction runs entirely in the webview. Rust hands the picked file's raw bytes to the front-end over IPC, the front-end opens it with pdf.js, maps positioned `TextItem`s into a local shape, assembles them into prose through pure functions, and passes the per-page text back to a Rust command that copies the PDF and inserts the project, its pages, and their text in one transaction. The Python sidecar is not involved at all.

**Tech Stack:** TypeScript + React 19, `pdfjs-dist` 6.3.289, vitest (node environment), Rust + Tauri 2.11.0, `rusqlite`, `lopdf`.

**Spec:** [docs/superpowers/specs/2026-09-12-m3-extraction-design.md](../specs/2026-09-12-m3-extraction-design.md) — read it before starting. The engine decision it rests on is recorded in [the docling spike](../specs/2026-09-12-m3-extraction-docling-spike.md).

## Global Constraints

- **Fully offline.** No network calls at runtime. pdf.js assets are already bundled by the `pdfjs-assets` plugin in `vite.config.ts`.
- **No OCR, in any language.** A page with no text layer stays empty. Do not add an OCR dependency, engine, or fallback.
- **No column or sidebar analysis.** Blocks are preserved in pdf.js stream order, never interpreted.
- **The Python sidecar is untouched.** Do not modify `sidecar/` or `src-tauri/src/sidecar.rs`.
- **No schema migration.** `PRAGMA user_version` stays at `1`. `source_text`, `edited_text`, and `used_ocr` already exist.
- **`pages.used_ocr` is always written `0`.** Text-layer extraction is not OCR.
- **`pages.edited_text` is never written by extraction.** Only `source_text`.
- **`source_text` NULL means "never extracted"; `''` means "extracted, genuinely empty".** Preserve the distinction.
- **User-facing name is Enisma; internal identifiers stay HearBook.** New user-facing strings say Enisma if they name the app.
- **New user-facing copy goes in all four catalogues** — `src/locales/{en,am,om,ti}.json` — as `{ message, context }` entries. Errors surfaced from Rust stay English and are not translated.
- **Markdown is never hard-wrapped.** One line per paragraph in any `.md` you touch.
- **Conventional Commits** for every commit: `<type>: <subject>` or `<type>(scope): <subject>`.
- Front-end tests run with `bun run test`; Rust tests with `cargo test` from `src-tauri/`.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/lib/extract-assemble.ts` | Pure assembly: positioned items in, prose out. No pdf.js import, no I/O. All thresholds. |
| `src/lib/extract-assemble.test.ts` | Unit tests for the above, with hand-built item arrays. |
| `src/lib/extract.ts` | `TextItem` → local shape mapping, and document-level extraction over a minimal document interface. No pdf.js import. |
| `src/lib/extract.test.ts` | Integration test: opens the fixture with pdf.js in node, runs it through `extract.ts`. |
| `src/lib/extract-open.ts` | Browser-only: opens a pdf.js document from bytes or a URL, delegates to `extract.ts`. |
| `src/lib/pdfjs-setup.ts` | Shared pdf.js worker and bundled-asset URLs, moved out of `pdf-viewer.tsx`. |
| `src/lib/__fixtures__/three-pages.pdf` | Small test PDF for the front-end test tree. |

**Modified:** `src/lib/api.ts`, `src/components/home/import-dialog.tsx`, `src/components/editor/editor.tsx`, `src/components/editor/center-panel.tsx`, `src/components/editor/pdf-viewer.tsx`, `src/locales/*.json`, `src-tauri/src/pdf.rs`, `src-tauri/src/import.rs`, `src-tauri/src/project.rs`, `src-tauri/src/lib.rs`.

**Task order:** Tasks 1–5 build the pure assembly layer bottom-up and are the bulk of the logic. Task 6 wires pdf.js to it. Tasks 7–9 are the Rust surface. Tasks 10–13 are the UI. Tasks 1–5 have no dependencies outside themselves and can be reviewed in isolation.

---

### Task 1: Item de-duplication and line building

**Files:**
- Create: `src/lib/extract-assemble.ts`
- Test: `src/lib/extract-assemble.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type RawItem = { str: string; x: number; y: number; height: number; hasEOL: boolean }`, `type Line = { text: string; x: number; y: number }`, `dedupeItems(items: RawItem[]): RawItem[]`, `toLines(items: RawItem[]): Line[]`, and the constants `MIN_LINE_Y_TOLERANCE`, `LINE_Y_TOLERANCE_RATIO`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/extract-assemble.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: FAIL — `Failed to resolve import "./extract-assemble"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/extract-assemble.ts`:

```ts
/**
 * Text assembly: positioned pdf.js text items in, readable prose out.
 *
 * Pure by design — no pdf.js import and no I/O — so it tests in the node
 * environment with hand-built arrays, which is where nearly all of this
 * milestone's logic lives.
 *
 * Every threshold here was tuned against one textbook's typography. A
 * different publisher's layout will need them revisited, which is why they
 * are named constants in one place rather than literals at their use sites.
 */

/**
 * The slice of a pdf.js `TextItem` assembly needs. Deliberately not pdf.js's
 * own type: `TextItem` carries no x/y (they live in `transform[4]`/`[5]`), and
 * depending on it here would drag pdf.js into a module that must stay pure.
 */
export type RawItem = {
  str: string;
  x: number;
  y: number;
  height: number;
  hasEOL: boolean;
};

/** One assembled line of text, with the position it came from. */
export type Line = { text: string; x: number; y: number };

/** Smallest y gap, in PDF units, that can separate two lines. */
export const MIN_LINE_Y_TOLERANCE = 2;
/** Share of an item's height within which another item counts as same-line. */
export const LINE_Y_TOLERANCE_RATIO = 0.5;

/**
 * Drop items that repeat the same string at the same place.
 *
 * Overlapping draws are real: the sample textbook's footer page number was
 * emitted twice, so joining items produced "3333" instead of "33". Positions
 * are rounded because the duplicate is not always pixel-identical.
 */
export function dedupeItems(items: RawItem[]): RawItem[] {
  const seen = new Set<string>();
  const out: RawItem[] = [];
  for (const it of items) {
    const key = `${it.str}@${Math.round(it.x)},${Math.round(it.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Group items into lines by vertical proximity.
 *
 * `hasEOL` is not the boundary. On sample page 40 a running header and the
 * heading beneath it arrived inside a single `hasEOL` run; trusting that flag
 * fuses page furniture to real content, after which no line-level rule can
 * tell them apart. y-proximity separates them.
 */
export function toLines(items: RawItem[]): Line[] {
  const groups: { y: number; items: RawItem[] }[] = [];
  let current: { y: number; items: RawItem[] } | null = null;

  for (const it of items) {
    const tolerance = Math.max(MIN_LINE_Y_TOLERANCE, it.height * LINE_Y_TOLERANCE_RATIO);
    if (current && Math.abs(it.y - current.y) <= tolerance) {
      current.items.push(it);
    } else {
      current = { y: it.y, items: [it] };
      groups.push(current);
    }
  }

  return groups
    .map((group) => {
      const ordered = [...group.items].sort((a, b) => a.x - b.x);
      return {
        text: ordered
          .map((i) => i.str)
          .join("")
          .replace(/\s+/g, " ")
          .trim(),
        x: Math.min(...ordered.map((i) => i.x)),
        y: group.y,
      };
    })
    .filter((line) => line.text !== "");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract-assemble.ts src/lib/extract-assemble.test.ts
git commit -m "feat(extract): group pdf.js text items into lines"
```

---

### Task 2: Block segmentation and within-block ordering

**Files:**
- Modify: `src/lib/extract-assemble.ts`
- Test: `src/lib/extract-assemble.test.ts`

**Interfaces:**
- Consumes: `Line`, `toLines` from Task 1.
- Produces: `type Block = { x: number; lines: Line[] }`, `toBlocks(lines: Line[]): Block[]`, `sortBlockLines(block: Block): Block`, constant `COLUMN_GAP`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/extract-assemble.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: FAIL — `toBlocks is not a function` (or an unresolved export).

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/extract-assemble.ts`:

```ts
/** A run of lines sharing a left edge — a column, a sidebar, or a header. */
export type Block = { x: number; lines: Line[] };

/**
 * Largest left-edge difference, in PDF units, still counted as the same block.
 * Wide enough to keep a bullet's indent with its paragraph, narrow enough to
 * separate a main column from a sidebar.
 */
export const COLUMN_GAP = 40;

/**
 * Segment a page's lines into blocks at left-edge discontinuities.
 *
 * This is segmentation, not analysis: no block is classified, and their
 * relative order is pdf.js's. That order already keeps side-by-side content
 * contiguous on the sample textbook, which is why column analysis is out of
 * scope for v0 — see the spec's non-goals.
 */
export function toBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of lines) {
    if (current && Math.abs(line.x - current.x) < COLUMN_GAP) {
      current.lines.push(line);
    } else {
      current = { x: line.x, lines: [line] };
      blocks.push(current);
    }
  }
  return blocks;
}

/**
 * Order a block's lines by descending y, which is reading order in PDF space.
 *
 * Scoped to a block on purpose. Sorting a whole page by y would interleave a
 * sidebar back into the body it sits beside, undoing the one thing pdf.js's
 * own ordering gets right.
 */
export function sortBlockLines(block: Block): Block {
  return { ...block, lines: [...block.lines].sort((a, b) => b.y - a.y) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract-assemble.ts src/lib/extract-assemble.test.ts
git commit -m "feat(extract): segment lines into blocks and order them by position"
```

---

### Task 3: Paragraph reflow

**Files:**
- Modify: `src/lib/extract-assemble.ts`
- Test: `src/lib/extract-assemble.test.ts`

**Interfaces:**
- Consumes: `Line` from Task 1.
- Produces: `reflowLines(lines: Line[]): string[]`, constant `REFLOW_WIDTH_RATIO`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/extract-assemble.test.ts`:

```ts
import { reflowLines } from "./extract-assemble";

describe("reflowLines", () => {
  it("joins hard-wrapped lines into one paragraph", () => {
    const paragraphs = reflowLines([
      line("Their bodies consist of long, slender thread-like structures called", 57, 557),
      line("hyphae. Hyphae play an important role in how they obtain food.", 57, 541),
    ]);
    expect(paragraphs).toEqual([
      "Their bodies consist of long, slender thread-like structures called hyphae. Hyphae play an important role in how they obtain food.",
    ]);
  });

  it("starts a new paragraph after a line that ends a sentence", () => {
    const paragraphs = reflowLines([
      line("Fungi possess a cell wall made up of chitin and polysaccharides.", 57, 516),
      line("Like animals, fungi are heterotrophic in nutrition. But unlike", 57, 492),
    ]);
    expect(paragraphs).toHaveLength(2);
  });

  // A fixed 40-character minimum worked on the main column and wrongly left
  // the sample sidebar's ~25-character lines unjoined. The threshold has to be
  // relative to the block's own typical line width.
  it("joins a narrow column's short lines", () => {
    const paragraphs = reflowLines([
      line("So far, you have studied", 411, 711),
      line("bacteria, and protists. In", 411, 697),
      line("this section, you will learn", 411, 683),
      line("about the kingdom Fungi.", 411, 669),
    ]);
    expect(paragraphs).toEqual([
      "So far, you have studied bacteria, and protists. In this section, you will learn about the kingdom Fungi.",
    ]);
  });

  it("keeps each list item on its own", () => {
    const paragraphs = reflowLines([
      line("At the end of this section, the student will be able to:", 66, 726),
      line("• describe the kingdom fungi and give example of organisms", 81, 709),
      line("• describe the importance of fungi", 81, 694),
    ]);
    expect(paragraphs).toHaveLength(3);
  });

  it("keeps a numbered list item on its own", () => {
    const paragraphs = reflowLines([
      line("Follow these rules in the laboratory", 57, 600),
      line("3. Dressing for the laboratory", 57, 580),
    ]);
    expect(paragraphs).toHaveLength(2);
  });

  it("does not join a short line that is really a heading", () => {
    const paragraphs = reflowLines([
      line("What are fungi?", 57, 662),
      line("Fungi are eukaryotic organisms that include micro-organisms such as", 57, 638),
      line("yeasts, moulds and mushrooms.", 57, 622),
    ]);
    expect(paragraphs[0]).toBe("What are fungi?");
    expect(paragraphs).toHaveLength(2);
  });

  it("returns nothing for no lines", () => {
    expect(reflowLines([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: FAIL — `reflowLines is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/extract-assemble.ts`:

```ts
/**
 * Share of a block's median line width above which a line is long enough to
 * read as a wrapped continuation rather than a deliberately short one.
 */
export const REFLOW_WIDTH_RATIO = 0.8;

/** True for a line opening a bulleted or numbered list item. */
function startsListItem(text: string): boolean {
  return /^\s*([•·▪—–-]|\(?\d+[.)])\s/.test(text);
}

/** True for a line whose last visible character closes a sentence. */
function endsSentence(text: string): boolean {
  return /[.!?:;]["'”’)\]]?$/.test(text);
}

/**
 * Join hard-wrapped lines back into paragraphs.
 *
 * A line continues the previous one unless the previous ended a sentence, the
 * current opens a list item, or the previous was short enough to have ended
 * deliberately — a heading, say. That last test is measured against the
 * block's own median line width, not a fixed character count: an absolute
 * threshold reflowed the sample textbook's main column correctly while leaving
 * its narrow sidebar untouched.
 */
export function reflowLines(lines: Line[]): string[] {
  if (lines.length === 0) return [];

  const widths = lines.map((l) => l.text.length).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  const continuationMin = median * REFLOW_WIDTH_RATIO;

  const paragraphs: string[] = [];
  for (const line of lines) {
    const previous = paragraphs[paragraphs.length - 1];
    const continues =
      previous !== undefined &&
      !endsSentence(previous) &&
      !startsListItem(line.text) &&
      previous.length >= continuationMin;
    if (continues) {
      paragraphs[paragraphs.length - 1] = `${previous} ${line.text}`;
    } else {
      paragraphs.push(line.text);
    }
  }
  return paragraphs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract-assemble.ts src/lib/extract-assemble.test.ts
git commit -m "feat(extract): reflow hard-wrapped lines into paragraphs"
```

---

### Task 4: Running header and footer removal

**Files:**
- Modify: `src/lib/extract-assemble.ts`
- Test: `src/lib/extract-assemble.test.ts`

**Interfaces:**
- Consumes: `Line`, `Block` from Tasks 1–2.
- Produces: `lineKey(line: Line): string`, `furnitureKeys(pages: Block[][]): Set<string>`, constants `FURNITURE_Y_BAND`, `FURNITURE_MAX_CHARS`, `FURNITURE_MIN_PAGE_SHARE`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/extract-assemble.test.ts`:

```ts
import { furnitureKeys, lineKey } from "./extract-assemble";

/** Four pages that each carry the same running header and a varying footer. */
function bookWithFurniture(): Block[][] {
  return [33, 34, 35, 36].map((pageNumber, index) => [
    { x: 342, lines: [line("Unit Two: Characteristics and Classification of Organisms", 342, 794)] },
    { x: 57, lines: [line(`Body prose unique to page ${index}`, 57, 600)] },
    { x: 57, lines: [line(`Grade 9 Biology ${pageNumber}`, 57, 40)] },
  ]);
}

describe("lineKey", () => {
  // Page numbers differ per page, so the raw text never repeats. Normalizing
  // digit runs is what lets a footer collapse to one key.
  it("normalizes digit runs so per-page numbers collapse together", () => {
    expect(lineKey(line("Grade 9 Biology 33", 57, 40))).toBe(
      lineKey(line("Grade 9 Biology 34", 57, 40)),
    );
  });

  it("ignores case and surrounding space", () => {
    expect(lineKey(line("  Unit Two  ", 342, 794))).toBe(lineKey(line("unit two", 342, 794)));
  });

  it("distinguishes the same text at a different height on the page", () => {
    expect(lineKey(line("Fungi", 57, 794))).not.toBe(lineKey(line("Fungi", 57, 40)));
  });
});

describe("furnitureKeys", () => {
  it("finds a header repeating on every page", () => {
    const keys = furnitureKeys(bookWithFurniture());
    expect(keys.has(lineKey(line("Unit Two: Characteristics and Classification of Organisms", 342, 794)))).toBe(true);
  });

  it("finds a footer whose page number varies", () => {
    const keys = furnitureKeys(bookWithFurniture());
    expect(keys.has(lineKey(line("Grade 9 Biology 33", 57, 40)))).toBe(true);
  });

  it("leaves body prose alone", () => {
    const keys = furnitureKeys(bookWithFurniture());
    expect(keys.has(lineKey(line("Body prose unique to page 0", 57, 600)))).toBe(false);
  });

  it("ignores a long line even when it repeats", () => {
    const long = "x".repeat(200);
    const pages: Block[][] = [0, 1, 2, 3].map(() => [{ x: 57, lines: [line(long, 57, 600)] }]);
    expect(furnitureKeys(pages).has(lineKey(line(long, 57, 600)))).toBe(false);
  });

  // A two-page document would otherwise make every repeated line furniture.
  it("needs at least two pages carrying a line before calling it furniture", () => {
    const pages: Block[][] = [[{ x: 57, lines: [line("Only here", 57, 794)] }]];
    expect(furnitureKeys(pages).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: FAIL — `furnitureKeys is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/extract-assemble.ts`:

```ts
/** Height of the vertical bands lines are bucketed into, in PDF units. */
export const FURNITURE_Y_BAND = 12;
/** Longest a line may be and still be considered page furniture. */
export const FURNITURE_MAX_CHARS = 120;
/** Share of pages a line must appear on to count as furniture. */
export const FURNITURE_MIN_PAGE_SHARE = 0.5;

/**
 * Identity of a line for repetition counting: its text with digit runs
 * flattened, plus the band of the page it sits in.
 *
 * Digits are flattened because a footer's page number changes on every page,
 * so the literal text never repeats even though the furniture does. The band
 * keeps a phrase in a header from matching the same phrase in body prose.
 */
export function lineKey(line: Line): string {
  const normalized = line.text.replace(/\d+/g, "#").trim().toLowerCase();
  return `${Math.round(line.y / FURNITURE_Y_BAND)}|${normalized}`;
}

/**
 * Find the lines that are page furniture rather than content.
 *
 * Repetition across the book is the signal, which is why this takes every page
 * at once and why extraction is a whole-document operation: a single page
 * cannot tell a running header from a heading.
 *
 * The risk this accepts is stated in the spec — a short line that genuinely
 * repeats at the same position on most pages, such as a recurring workbook
 * instruction, is indistinguishable from a header by this rule.
 */
export function furnitureKeys(pages: Block[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const blocks of pages) {
    const seenOnThisPage = new Set<string>();
    for (const block of blocks) {
      for (const line of block.lines) {
        if (line.text.length > FURNITURE_MAX_CHARS) continue;
        const key = lineKey(line);
        if (seenOnThisPage.has(key)) continue;
        seenOnThisPage.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  // At least two pages, so a one-page document has no furniture at all.
  const threshold = Math.max(2, Math.ceil(pages.length * FURNITURE_MIN_PAGE_SHARE));
  const furniture = new Set<string>();
  for (const [key, appearances] of counts) {
    if (appearances >= threshold) furniture.add(key);
  }
  return furniture;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract-assemble.ts src/lib/extract-assemble.test.ts
git commit -m "feat(extract): drop running headers and footers by cross-page repetition"
```

---

### Task 5: Document assembly and emptiness thresholds

**Files:**
- Modify: `src/lib/extract-assemble.ts`
- Test: `src/lib/extract-assemble.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `assembleDocument(pages: RawItem[][]): string[]`, `isEmptyPage(text: string): boolean`, `looksScanned(pageTexts: string[]): boolean`, constants `EMPTY_PAGE_MIN_CHARS`, `SCANNED_PAGE_SHARE`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/extract-assemble.test.ts`:

```ts
import {
  assembleDocument,
  isEmptyPage,
  looksScanned,
  EMPTY_PAGE_MIN_CHARS,
} from "./extract-assemble";

describe("assembleDocument", () => {
  /** Two pages sharing a running header, each with a wrapped paragraph. */
  function twoPages(): RawItem[][] {
    return [0, 1].map((n) => [
      item("Unit Two: Characteristics and Classification of Organisms", 342, 794),
      item(`Page ${n} opens with a sentence that wraps across`, 57, 600),
      item(`two lines before it finally ends here.`, 57, 584),
    ]);
  }

  it("returns one string per page", () => {
    expect(assembleDocument(twoPages())).toHaveLength(2);
  });

  it("removes the running header and reflows the paragraph", () => {
    const [first] = assembleDocument(twoPages());
    expect(first).not.toContain("Unit Two");
    expect(first).toBe("Page 0 opens with a sentence that wraps across two lines before it finally ends here.");
  });

  it("separates blocks with a blank line", () => {
    const [page] = assembleDocument([
      [
        item("Main column prose that is quite long indeed here.", 57, 600),
        item("Sidebar text over here", 433, 600),
      ],
    ]);
    expect(page).toBe("Main column prose that is quite long indeed here.\n\nSidebar text over here");
  });

  it("gives an empty string for a page with no items", () => {
    expect(assembleDocument([[]])).toEqual([""]);
  });

  it("gives an empty string, not whitespace, for a page of blank items", () => {
    expect(assembleDocument([[item("   ", 57, 600)]])).toEqual([""]);
  });

  it("collapses a doubled page number", () => {
    const [page] = assembleDocument([[item("33", 300, 40), item("33", 300, 40)]]);
    expect(page).toBe("33");
  });
});

describe("isEmptyPage", () => {
  it("counts a page below the character floor as empty", () => {
    expect(isEmptyPage("Fixture page 1")).toBe(true);
  });

  it("does not count a page of real prose as empty", () => {
    expect(isEmptyPage("x".repeat(EMPTY_PAGE_MIN_CHARS))).toBe(false);
  });

  it("ignores whitespace when counting", () => {
    expect(isEmptyPage(" ".repeat(200))).toBe(true);
  });
});

describe("looksScanned", () => {
  it("is true when nearly every page is empty", () => {
    expect(looksScanned(["", "", "", "", "x".repeat(100)])).toBe(true);
  });

  // The sample textbook has 3 empty pages out of 171 — cover and blanks.
  it("is false for a book with a few blank pages", () => {
    const pages = Array.from({ length: 171 }, (_, i) => (i < 3 ? "" : "x".repeat(100)));
    expect(looksScanned(pages)).toBe(false);
  });

  it("is false for no pages at all", () => {
    expect(looksScanned([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test src/lib/extract-assemble.test.ts`
Expected: FAIL — `assembleDocument is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/extract-assemble.ts`:

```ts
/**
 * Non-whitespace characters a page must hold to count as having text.
 *
 * On the sample textbook this flags exactly the two genuinely blank pages and
 * leaves the 199-character cover alone.
 */
export const EMPTY_PAGE_MIN_CHARS = 50;

/** Share of empty pages at which a document is reported as looking scanned. */
export const SCANNED_PAGE_SHARE = 0.8;

/**
 * Assemble a whole document's items into one string per page.
 *
 * Whole-document rather than per-page because furniture removal needs every
 * page to see what repeats. The repair path calls this too, for the same
 * reason: a page assembled alone would keep the header every other page had
 * stripped.
 */
export function assembleDocument(pages: RawItem[][]): string[] {
  const blocksPerPage = pages.map((items) =>
    toBlocks(toLines(dedupeItems(items))).map(sortBlockLines),
  );
  const furniture = furnitureKeys(blocksPerPage);

  return blocksPerPage.map((blocks) =>
    blocks
      .map((block) => reflowLines(block.lines.filter((line) => !furniture.has(lineKey(line)))))
      .filter((paragraphs) => paragraphs.length > 0)
      .map((paragraphs) => paragraphs.join("\n\n"))
      .join("\n\n")
      .trim(),
  );
}

/** True when a page holds too little text to be worth speaking. */
export function isEmptyPage(text: string): boolean {
  return text.replace(/\s/g, "").length < EMPTY_PAGE_MIN_CHARS;
}

/**
 * True when a document looks like a scan rather than a digital PDF.
 *
 * Enisma has no OCR, so this is what lets import warn before creating a
 * project whose every page would be blank.
 */
export function looksScanned(pageTexts: string[]): boolean {
  if (pageTexts.length === 0) return false;
  const empty = pageTexts.filter(isEmptyPage).length;
  return empty / pageTexts.length >= SCANNED_PAGE_SHARE;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: PASS — all suites, including the four pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/extract-assemble.ts src/lib/extract-assemble.test.ts
git commit -m "feat(extract): assemble whole documents and detect scanned PDFs"
```

---

### Task 6: pdf.js driver

**Files:**
- Create: `src/lib/extract.ts`, `src/lib/extract.test.ts`, `src/lib/extract-open.ts`, `src/lib/pdfjs-setup.ts`, `src/lib/__fixtures__/three-pages.pdf`
- Modify: `src/components/editor/pdf-viewer.tsx:8-31`

**Interfaces:**
- Consumes: `assembleDocument`, `isEmptyPage`, `looksScanned`, `RawItem` from Task 5.
- Produces: `type ExtractResult = { pageTexts: string[]; emptyPages: number; looksScanned: boolean }`, `toRawItems(items: unknown[]): RawItem[]`, `extractFromDocument(doc: DocumentLike): Promise<ExtractResult>` in `extract.ts`; `extractFromBytes(bytes: Uint8Array): Promise<ExtractResult>` and `extractFromUrl(url: string): Promise<ExtractResult>` in `extract-open.ts`; `PDFJS_ASSET_URLS` in `pdfjs-setup.ts`.

- [ ] **Step 1: Copy the test fixture**

```bash
mkdir -p src/lib/__fixtures__
cp src-tauri/tests/fixtures/three-pages.pdf src/lib/__fixtures__/three-pages.pdf
```

This is a deliberate 3 KB duplicate of the Rust fixture, so the front-end test tree does not reach into `src-tauri/tests/`. Its three pages each carry the text `Fixture page N`.

- [ ] **Step 2: Write the failing test**

Create `src/lib/extract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractFromDocument, toRawItems } from "./extract";

/**
 * Opens the fixture with pdf.js's legacy build, which is the one that runs
 * under Node. The app itself imports the default build; the split between
 * `extract.ts` and `extract-open.ts` is what lets this test exercise the
 * mapping without needing the browser entry point.
 */
async function fixtureDocument() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const path = fileURLToPath(new URL("./__fixtures__/three-pages.pdf", import.meta.url));
  const data = new Uint8Array(await readFile(path));
  return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
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
    expect(result.pageTexts[0]).toContain("Fixture page 1");
    expect(result.pageTexts[2]).toContain("Fixture page 3");
  });

  it("counts the fixture's sparse pages as empty and so calls it scanned", async () => {
    // Each fixture page holds 12 characters, well under the 50-character floor.
    const result = await extractFromDocument(await fixtureDocument());
    expect(result.emptyPages).toBe(3);
    expect(result.looksScanned).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test src/lib/extract.test.ts`
Expected: FAIL — `Failed to resolve import "./extract"`.

- [ ] **Step 4: Write `extract.ts`**

Create `src/lib/extract.ts`:

```ts
import {
  assembleDocument,
  isEmptyPage,
  looksScanned,
  type RawItem,
} from "./extract-assemble";

/** What extraction reports back about one document. */
export type ExtractResult = {
  /** One assembled string per page, in page order. */
  pageTexts: string[];
  /** How many of those hold too little text to speak. */
  emptyPages: number;
  /** Whether the document looks like a scan Enisma cannot read. */
  looksScanned: boolean;
};

/** The slice of a pdf.js page this module uses. */
export type TextPageLike = {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup?(): void;
};

/**
 * The slice of a pdf.js document this module uses.
 *
 * Narrow on purpose: it lets the test open a document with the Node-capable
 * legacy build while the app opens one with the browser build, without this
 * module importing either.
 */
export type DocumentLike = {
  numPages: number;
  getPage(pageNumber: number): Promise<TextPageLike>;
};

/** Height assumed for an item whose own height is missing or zero. */
const DEFAULT_ITEM_HEIGHT = 10;

/**
 * Map pdf.js text content entries onto the shape assembly works with.
 *
 * Two details drive this. `items` interleaves `TextMarkedContent` entries that
 * carry no `str`, so they are filtered out. And `TextItem` has no x or y
 * fields — position lives at indices 4 and 5 of its transform matrix.
 */
export function toRawItems(items: unknown[]): RawItem[] {
  const mapped: RawItem[] = [];
  for (const entry of items) {
    const candidate = entry as {
      str?: unknown;
      transform?: unknown;
      height?: unknown;
      hasEOL?: unknown;
    };
    if (typeof candidate.str !== "string" || candidate.str === "") continue;
    const transform = candidate.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const height =
      typeof candidate.height === "number" && candidate.height > 0
        ? candidate.height
        : DEFAULT_ITEM_HEIGHT;
    mapped.push({
      str: candidate.str,
      x: Number(transform[4]),
      y: Number(transform[5]),
      height,
      hasEOL: candidate.hasEOL === true,
    });
  }
  return mapped;
}

/**
 * Extract and assemble every page of an already-opened document.
 *
 * Pages are walked in order and assembled together, because furniture removal
 * needs the whole document to see what repeats.
 */
export async function extractFromDocument(doc: DocumentLike): Promise<ExtractResult> {
  const pages: RawItem[][] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(toRawItems(content.items));
    // Release the page's cached operator list; a textbook is hundreds of pages.
    page.cleanup?.();
  }

  const pageTexts = assembleDocument(pages);
  return {
    pageTexts,
    emptyPages: pageTexts.filter(isEmptyPage).length,
    looksScanned: looksScanned(pageTexts),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test src/lib/extract.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Move the shared pdf.js setup out of the viewer**

Create `src/lib/pdfjs-setup.ts` by moving the worker assignment and asset URLs verbatim out of `src/components/editor/pdf-viewer.tsx` (lines 8–31), preserving the existing comments:

```ts
import * as pdfjs from "pdfjs-dist";

// Bundled by Vite from the installed package; no network fetch.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/**
 * Runtime asset directories pdf.js fetches from, copied into our own bundle by
 * the `pdfjs-assets` plugin in `vite.config.ts`. Resolved against the document
 * so the same code works behind Vite's dev server and behind `tauri://` in a
 * packaged build. Each needs a trailing slash — pdf.js concatenates a filename
 * onto it and rejects a base without one.
 *
 * `wasmUrl` is the one that matters for this product's input: pdf.js decodes
 * JBIG2, CCITTFax and JPX images through WebAssembly, and a missing base URL
 * makes those decoders fail. Because `getDocument` defaults `stopAtErrors` to
 * false, such a failure is logged as a warning and the image is dropped, so an
 * undecodable scan renders as a blank page rather than an error.
 *
 * Shared by the viewer and by extraction, which open the same documents and so
 * must agree about where these live.
 */
const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;
export const PDFJS_ASSET_URLS = {
  wasmUrl: asset("wasm"),
  cMapUrl: asset("cmaps"),
  standardFontDataUrl: asset("standard_fonts"),
};
```

Then in `pdf-viewer.tsx`, delete those lines and import instead:

```ts
import { PDFJS_ASSET_URLS } from "@/lib/pdfjs-setup";
```

Leave every other use of `PDFJS_ASSET_URLS` in that file unchanged.

- [ ] **Step 7: Write `extract-open.ts`**

Create `src/lib/extract-open.ts`:

```ts
import * as pdfjs from "pdfjs-dist";
import { PDFJS_ASSET_URLS } from "./pdfjs-setup";
import { extractFromDocument, type ExtractResult } from "./extract";

/**
 * Browser-only entry points for extraction.
 *
 * Separate from `extract.ts` so that module — where the mapping and assembly
 * logic lives — can be imported by a Node test without pulling in pdf.js's
 * browser build or touching `document`.
 */

/** Extract a document held in memory. Used by import, before the file is copied. */
export async function extractFromBytes(bytes: Uint8Array): Promise<ExtractResult> {
  const loading = pdfjs.getDocument({ data: bytes, ...PDFJS_ASSET_URLS });
  try {
    return await extractFromDocument(await loading.promise);
  } finally {
    loading.destroy();
  }
}

/** Extract a document already on disk. Used by the repair pass on editor open. */
export async function extractFromUrl(url: string): Promise<ExtractResult> {
  const loading = pdfjs.getDocument({ url, ...PDFJS_ASSET_URLS });
  try {
    return await extractFromDocument(await loading.promise);
  } finally {
    loading.destroy();
  }
}
```

- [ ] **Step 8: Verify nothing regressed**

Run: `bun run test`
Expected: PASS, all suites.

Run: `bun run build`
Expected: succeeds — this is what catches a broken import in `pdf-viewer.tsx`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/extract.ts src/lib/extract.test.ts src/lib/extract-open.ts src/lib/pdfjs-setup.ts src/lib/__fixtures__/three-pages.pdf src/components/editor/pdf-viewer.tsx
git commit -m "feat(extract): drive extraction from pdf.js text content"
```

---

### Task 7: Rust command to read a picked PDF's bytes

**Files:**
- Modify: `src-tauri/src/pdf.rs`, `src-tauri/src/project.rs`, `src-tauri/src/lib.rs:43-52`, `src/lib/api.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pdf::read_source_bytes(path: &Path) -> Result<Vec<u8>, String>`, `pdf::MAX_PDF_BYTES: u64`, command `read_pdf_bytes_cmd(path: String) -> Result<tauri::ipc::Response, String>`, and `readPdfBytes(path: string): Promise<Uint8Array>` in `api.ts`.

- [ ] **Step 1: Write the failing Rust tests**

Append to the `mod tests` block in `src-tauri/src/pdf.rs`:

```rust
    #[test]
    fn read_source_bytes_returns_the_file() {
        let bytes = super::read_source_bytes(&fixture()).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "should be the raw PDF");
    }

    #[test]
    fn read_source_bytes_rejects_a_missing_file() {
        let missing = std::env::temp_dir().join("enisma-no-such-file.pdf");
        let err = super::read_source_bytes(&missing).unwrap_err();
        assert!(err.contains("could not read PDF"), "got: {err}");
    }

    #[test]
    fn read_source_bytes_rejects_a_directory() {
        let err = super::read_source_bytes(&std::env::temp_dir()).unwrap_err();
        assert!(err.contains("not a file"), "got: {err}");
    }
```

If `pdf.rs`'s existing `mod tests` has no `fixture()` helper, add one matching `import.rs`:

```rust
    fn fixture() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/three-pages.pdf")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test read_source_bytes`
Expected: FAIL to compile — `cannot find function read_source_bytes`.

- [ ] **Step 3: Implement the reader**

Append to `src-tauri/src/pdf.rs`, above its `mod tests`:

```rust
/// Largest PDF handed to the webview for extraction.
///
/// The webview buffers the whole file, so this bounds its memory. Generous for
/// a scanned textbook, which runs to tens of megabytes.
pub const MAX_PDF_BYTES: u64 = 256 * 1024 * 1024;

/// Read a picked PDF whole, for extraction in the webview.
///
/// Only needed before import, while the file is still outside the app data
/// directory: once copied, the asset protocol already grants the webview
/// access and pdf.js loads it by URL instead.
pub fn read_source_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("could not read PDF: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_PDF_BYTES {
        return Err(format!(
            "PDF is larger than the {} MB limit",
            MAX_PDF_BYTES / (1024 * 1024)
        ));
    }
    std::fs::read(path).map_err(|e| format!("could not read PDF: {e}"))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test read_source_bytes`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the command**

Append to `src-tauri/src/project.rs`:

```rust
/// Hand a picked PDF's bytes to the webview so pdf.js can extract its text.
///
/// Returns `tauri::ipc::Response`, which travels as raw bytes rather than
/// JSON — an 11 MB textbook encoded as a JSON number array would not be
/// acceptable. `async` so a large read does not block the IPC dispatch thread.
#[tauri::command(async)]
pub fn read_pdf_bytes_cmd(path: String) -> Result<tauri::ipc::Response, String> {
    crate::pdf::read_source_bytes(std::path::Path::new(&path)).map(tauri::ipc::Response::new)
}
```

Register it in `src-tauri/src/lib.rs`, in the `tauri::generate_handler!` list, immediately after `project::import_project_cmd`:

```rust
            project::read_pdf_bytes_cmd,
```

- [ ] **Step 6: Add the front-end wrapper**

In `src/lib/api.ts`, add:

```ts
/**
 * Read a picked PDF's bytes for extraction.
 *
 * The command returns a raw IPC response, which arrives as an ArrayBuffer.
 * The array fallback keeps this working if it ever arrives JSON-encoded.
 */
export const readPdfBytes = async (path: string): Promise<Uint8Array> => {
  const bytes = await invoke<ArrayBuffer | number[]>("read_pdf_bytes_cmd", { path });
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes);
};
```

- [ ] **Step 7: Verify it compiles**

Run: `cd src-tauri && cargo test`
Expected: PASS, all tests.

Run: `bun run build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/pdf.rs src-tauri/src/project.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(import): hand a picked PDF's bytes to the webview for extraction"
```

---

### Task 8: Import writes extracted text

**Files:**
- Modify: `src-tauri/src/project.rs:39-62`, `src-tauri/src/import.rs:20-62`, `src/lib/api.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `project::create_project_with_id(conn, id, title, language, pdf_path, page_count, page_texts: &[String])`, `import::import_project(conn, data_dir, title, language, src, page_texts: &[String])`, and `importProject(title, language, srcPath, pageTexts: string[])` in `api.ts`.

- [ ] **Step 1: Write the failing Rust tests**

Append to the `mod tests` block in `src-tauri/src/import.rs`:

```rust
    #[test]
    fn import_stores_the_extracted_text_per_page() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("text");
        let texts = vec!["page one".to_string(), String::new(), "page three".to_string()];
        let id = import_project(&mut conn, &data, "T", "en", &fixture(), &texts).unwrap();

        let mut stmt = conn
            .prepare("SELECT page_no, source_text, used_ocr FROM pages WHERE project_id = ?1 ORDER BY page_no")
            .unwrap();
        let rows: Vec<(i64, Option<String>, i64)> = stmt
            .query_map([&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(rows[0], (1, Some("page one".to_string()), 0));
        // An extracted-but-blank page is the empty string, never NULL: NULL is
        // reserved for "never extracted" and drives the repair pass.
        assert_eq!(rows[1], (2, Some(String::new()), 0));
        assert_eq!(rows[2], (3, Some("page three".to_string()), 0));
    }

    #[test]
    fn a_page_count_disagreement_is_rejected_before_anything_is_written() {
        let mut conn = db::open_in_memory().unwrap();
        let data = temp_data_dir("count-mismatch");
        let texts = vec!["only one page".to_string()];

        let err = import_project(&mut conn, &data, "T", "en", &fixture(), &texts).unwrap_err();
        assert!(err.contains("1"), "error should name the counts: {err}");

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "no project row should survive a mismatch");
        assert!(
            !data.join("projects").exists()
                || std::fs::read_dir(data.join("projects")).unwrap().count() == 0,
            "nothing should be copied when the counts disagree"
        );
    }
```

Update every existing call in that `mod tests` to pass texts. The fixture has three pages, so use a three-element vector, e.g.:

```rust
    /// Three empty strings — one per fixture page — for tests that do not care
    /// about the text itself.
    fn no_text() -> Vec<String> {
        vec![String::new(); 3]
    }
```

and append `&no_text()` to the `import_project` / `import_with_id` calls in `import_copies_the_pdf_and_creates_rows`, `import_stores_a_relative_pdf_path`, `a_failed_copy_leaves_no_directory`, and `a_failed_transaction_leaves_no_directory`. For `a_non_pdf_leaves_no_directory_and_no_row` and `a_missing_source_is_rejected`, pass `&no_text()` as well — those fail before the count check.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test`
Expected: FAIL to compile — `import_project` takes 5 arguments, 6 supplied.

- [ ] **Step 3: Thread the texts through persistence**

In `src-tauri/src/project.rs`, change `create_project_with_id` to take the texts and write them:

```rust
pub fn create_project_with_id(
    conn: &mut Connection,
    id: &str,
    title: &str,
    language: &str,
    pdf_path: &str,
    page_count: i64,
    page_texts: &[String],
) -> rusqlite::Result<()> {
    let now = Utc::now().to_rfc3339();
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO projects
           (id, title, language, pdf_path, page_count, rate, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1.0, ?6, ?6)",
        params![id, title, language, pdf_path, page_count, now],
    )?;
    {
        // `used_ocr` is 0 for every row: text-layer extraction is not OCR, and
        // the column stays reserved until OCR actually arrives.
        let mut stmt = tx.prepare(
            "INSERT INTO pages (id, project_id, page_no, source_text, used_ocr)
             VALUES (?1, ?2, ?3, ?4, 0)",
        )?;
        for n in 1..=page_count {
            let text = page_texts.get((n - 1) as usize).map(String::as_str);
            stmt.execute(params![Uuid::new_v4().to_string(), id, n, text])?;
        }
    }
    tx.commit()
}
```

- [ ] **Step 4: Validate the counts in import**

In `src-tauri/src/import.rs`, add `page_texts: &[String]` as the last parameter of both `import_project` and `import_with_id`, pass it through, and insert the check immediately after `count_pages` — before the directory is created, so a mismatch writes nothing:

```rust
    // Parse before copying: a corrupt file fails here, having written nothing.
    let page_count = pdf::count_pages(src)?;

    // Rust owns the page count, as at M1: the process that owns the file owns
    // the facts about it. The webview's own count is a cross-check, and a
    // disagreement is loud rather than silently misfiling pages.
    if page_texts.len() as i64 != page_count {
        return Err(format!(
            "extracted {} pages but the PDF has {page_count}",
            page_texts.len()
        ));
    }
```

and pass the texts into the create call:

```rust
    if let Err(e) =
        project::create_project_with_id(conn, id, title, language, &rel, page_count, page_texts)
    {
```

- [ ] **Step 5: Update the command and the front-end wrapper**

In `src-tauri/src/project.rs`, `import_project_cmd` gains the parameter and passes it on:

```rust
#[tauri::command(async)]
pub fn import_project_cmd(
    db: State<'_, Db>,
    data: State<'_, DataDir>,
    title: String,
    language: String,
    src_path: String,
    page_texts: Vec<String>,
) -> Result<String, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::import::import_project(
        &mut conn,
        &data.0,
        &title,
        &language,
        std::path::Path::new(&src_path),
        &page_texts,
    )
}
```

In `src/lib/api.ts`:

```ts
export const importProject = (
  title: string,
  language: string,
  srcPath: string,
  pageTexts: string[],
) => invoke<string>("import_project_cmd", { title, language, srcPath, pageTexts });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/import.rs src-tauri/src/project.rs src/lib/api.ts
git commit -m "feat(import): store extracted page text in the import transaction"
```

---

### Task 9: Replacing source text, and reporting pages that lack it

**Files:**
- Modify: `src-tauri/src/project.rs`, `src-tauri/src/lib.rs`, `src/lib/api.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `project::replace_source_text(conn: &mut Connection, project_id: &str, page_texts: &[String]) -> Result<(), String>`, command `save_page_source_text_cmd(project_id: String, page_texts: Vec<String>)`, `ProjectDetail.pages_missing_text` / TS `pagesMissingText: number`, and `savePageSourceText(projectId, pageTexts)` in `api.ts`.

- [ ] **Step 1: Write the failing Rust tests**

Append to the `mod tests` block in `src-tauri/src/project.rs`:

```rust
    #[test]
    fn replace_source_text_overwrites_every_page_and_spares_edits() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &[String::new(), String::new(), String::new()]).unwrap();
        save_page_text(&conn, "p1", 2, "my correction").unwrap();

        super::replace_source_text(
            &mut conn,
            "p1",
            &["one".to_string(), "two".to_string(), "three".to_string()],
        )
        .unwrap();

        let mut stmt = conn
            .prepare("SELECT source_text, edited_text FROM pages WHERE project_id = 'p1' ORDER BY page_no")
            .unwrap();
        let rows: Vec<(Option<String>, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(rows[0].0, Some("one".to_string()));
        assert_eq!(rows[1].0, Some("two".to_string()));
        assert_eq!(rows[2].0, Some("three".to_string()));
        // The correction is what the user typed; a repair must never touch it.
        assert_eq!(rows[1].1, Some("my correction".to_string()));
    }

    #[test]
    fn replace_source_text_rejects_a_page_count_disagreement() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &[String::new(), String::new(), String::new()]).unwrap();

        let err = super::replace_source_text(&mut conn, "p1", &["only one".to_string()]).unwrap_err();
        assert!(err.contains("1"), "error should name the counts: {err}");
    }

    #[test]
    fn replace_source_text_leaves_updated_at_alone() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 1,
            &[String::new()]).unwrap();
        let before: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();

        super::replace_source_text(&mut conn, "p1", &["text".to_string()]).unwrap();

        let after: String = conn
            .query_row("SELECT updated_at FROM projects WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        // Repair is not an edit. Touching the timestamp would reorder the
        // library as though the user had just worked on the book.
        assert_eq!(before, after);
    }

    #[test]
    fn get_project_counts_pages_with_no_source_text() {
        let mut conn = db::open_in_memory().unwrap();
        create_project_with_id(&mut conn, "p1", "T", "en", "projects/p1/source.pdf", 3,
            &[String::new(), String::new(), String::new()]).unwrap();
        assert_eq!(get_project(&conn, "p1").unwrap().pages_missing_text, 0);

        conn.execute("UPDATE pages SET source_text = NULL WHERE page_no = 2", []).unwrap();
        assert_eq!(get_project(&conn, "p1").unwrap().pages_missing_text, 1);
    }
```

Also update any existing `create_project_with_id` calls already in this `mod tests` block to pass a texts slice of the right length.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test`
Expected: FAIL to compile — `cannot find function replace_source_text`, no field `pages_missing_text`.

- [ ] **Step 3: Implement `replace_source_text`**

Append to `src-tauri/src/project.rs`:

```rust
/// Replace every page's `source_text` for one project, in one transaction.
///
/// The repair path's only write. It deliberately does not touch `edited_text`,
/// `done`, or the project's `updated_at`: a repair restores what extraction
/// should have produced, and is not something the user did.
pub fn replace_source_text(
    conn: &mut Connection,
    project_id: &str,
    page_texts: &[String],
) -> Result<(), String> {
    let page_count: i64 = conn
        .query_row(
            "SELECT page_count FROM projects WHERE id = ?1",
            params![project_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if page_texts.len() as i64 != page_count {
        return Err(format!(
            "extracted {} pages but the project has {page_count}",
            page_texts.len()
        ));
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("UPDATE pages SET source_text = ?3 WHERE project_id = ?1 AND page_no = ?2")
            .map_err(|e| e.to_string())?;
        for (index, text) in page_texts.iter().enumerate() {
            stmt.execute(params![project_id, (index + 1) as i64, text])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Report how many pages lack text**

Add the field to the `ProjectDetail` struct in `src-tauri/src/project.rs`, following the `serde` rename convention already used there so it reaches the webview as `pagesMissingText`:

```rust
    /// How many pages have never been extracted (`source_text IS NULL`).
    /// Drives the editor's repair pass; `''` pages are extracted and do not
    /// count.
    pub pages_missing_text: i64,
```

Extend `get_project`'s query to populate it:

```rust
pub fn get_project(conn: &Connection, id: &str) -> rusqlite::Result<ProjectDetail> {
```

Add this correlated sub-select to that query's column list, and read it into the new field:

```sql
                (SELECT COUNT(*) FROM pages WHERE project_id = p.id AND source_text IS NULL)
```

- [ ] **Step 5: Add the command and the front-end wrapper**

In `src-tauri/src/project.rs`:

```rust
/// Replace a project's extracted text. Used by the editor's repair pass.
///
/// `async` so re-writing a few hundred rows does not block the IPC thread.
#[tauri::command(async)]
pub fn save_page_source_text_cmd(
    db: State<'_, Db>,
    project_id: String,
    page_texts: Vec<String>,
) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    replace_source_text(&mut conn, &project_id, &page_texts)
}
```

Register it in `src-tauri/src/lib.rs`'s handler list, after `project::save_page_text_cmd`:

```rust
            project::save_page_source_text_cmd,
```

In `src/lib/api.ts`, add the field to `ProjectDetail` and the wrapper:

```ts
export interface ProjectDetail {
  // …existing fields…
  /** Pages never extracted (`source_text IS NULL`). Non-zero triggers repair. */
  pagesMissingText: number;
}

export const savePageSourceText = (projectId: string, pageTexts: string[]) =>
  invoke<void>("save_page_source_text_cmd", { projectId, pageTexts });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS, all tests.

Run: `bun run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/project.rs src-tauri/src/lib.rs src/lib/api.ts
git commit -m "feat(extract): add a source-text replace path for repair"
```

---

### Task 10: User-facing copy

**Files:**
- Modify: `src/locales/en.json`, `src/locales/am.json`, `src/locales/ti.json`, `src/locales/om.json`

**Interfaces:**
- Consumes: nothing.
- Produces: catalogue keys `center.noTextLayer`, `center.extracting`, `import.extracting`, `import.scannedWarning`, `import.importAnyway`.

- [ ] **Step 1: Add the English entries**

In `src/locales/en.json`, add to the `center` group:

```json
  "noTextLayer": {
    "message": "This page has no text layer, so there is nothing to extract. Enisma cannot read scanned text yet — you can type this page here.",
    "context": "Faint placeholder inside the empty text editor, shown when extraction ran and found no text on this page — typically a scanned page. Should make clear this is expected, not a failure, and that typing is the way forward."
  },
  "extracting": {
    "message": "Reading the text from this book…",
    "context": "Faint placeholder inside the empty text editor while extraction is filling in a project that was missing its text. Brief and rare. Note the single-character ellipsis."
  },
```

and to the `import` group:

```json
  "extracting": {
    "message": "Reading the text…",
    "context": "Replaces the Import button label while the PDF's text is being extracted, before the project is created. Takes about a second. Note the single-character ellipsis."
  },
  "scannedWarning": {
    "message": "This PDF looks scanned — {empty} of {total} pages have no text layer. Enisma cannot read scanned text yet, so most pages would be empty.",
    "context": "Warning inside the import dialog, shown before the project is created. {empty} and {total} are page counts. The user can still choose to import."
  },
  "importAnyway": {
    "message": "Import anyway",
    "context": "Button. Confirms importing a PDF that appears to be scanned, accepting that most pages will be empty."
  },
```

- [ ] **Step 2: Translate into the other three catalogues**

Add the same five keys to `src/locales/am.json`, `src/locales/ti.json`, and `src/locales/om.json`, with translated `message` values and the **same** `context` values as English. Keep the ICU placeholders `{empty}` and `{total}` exactly as written, and keep the app name as **Enisma** untranslated.

- [ ] **Step 3: Verify the catalogues stay in step**

Run: `bun run test`
Expected: PASS — `i18n.test.ts` checks catalogue parity and will fail if a key is missing from any language.

- [ ] **Step 4: Commit**

```bash
git add src/locales
git commit -m "feat(i18n): add copy for extraction and scanned PDFs"
```

---

### Task 11: Import dialog extracts before creating the project

**Files:**
- Modify: `src/components/home/import-dialog.tsx`

**Interfaces:**
- Consumes: `readPdfBytes`, `importProject` (Tasks 7–8), `extractFromBytes` (Task 6), the catalogue keys from Task 10.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Replace `confirm` with a two-phase flow**

In `src/components/home/import-dialog.tsx`, add the imports:

```ts
import { importProject, readPdfBytes } from "@/lib/api";
import { extractFromBytes } from "@/lib/extract-open";
```

Add state for a held extraction result beside the existing `busy` and `error`:

```ts
  /**
   * Text already extracted from the picked PDF, held back because the book
   * looks scanned. Keeping it means confirming does not extract twice.
   */
  const [scanned, setScanned] = useState<{
    pageTexts: string[];
    emptyPages: number;
  } | null>(null);
```

Replace `confirm` with:

```ts
  /**
   * Extract first, create second.
   *
   * Extraction happens before any row exists, which is what lets the scanned
   * warning below offer a real cancel: nothing has been written, so there is
   * nothing to undo.
   */
  async function confirm(force = false) {
    if (!srcPath || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let pageTexts = scanned?.pageTexts;
      if (!pageTexts) {
        const result = await extractFromBytes(await readPdfBytes(srcPath));
        pageTexts = result.pageTexts;
        if (result.looksScanned && !force) {
          setScanned({ pageTexts, emptyPages: result.emptyPages });
          return;
        }
      }
      onImported(await importProject(title.trim(), language, srcPath, pageTexts));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 2: Show the warning**

Immediately after the existing `{error && (…)}` block, add:

```tsx
          {scanned && !error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {t("import.scannedWarning", {
                empty: scanned.emptyPages,
                total: scanned.pageTexts.length,
              })}
            </div>
          )}
```

- [ ] **Step 3: Make the footer reflect the phase**

Replace the `DialogFooter`'s confirm button with:

```tsx
          <Button onClick={() => confirm(scanned !== null)} disabled={busy || !title.trim()}>
            {t(
              busy
                ? scanned
                  ? "import.importing"
                  : "import.extracting"
                : scanned
                  ? "import.importAnyway"
                  : "import.confirm",
            )}
          </Button>
```

- [ ] **Step 4: Reset the held result when the title or language changes**

A different language does not change the extracted text, but a re-pick does. Add, after the `scanned` state declaration:

```ts
  // A newly picked file gets a fresh dialog (Home remounts it per pick), so
  // the only stale case to guard is the user backing out of the warning.
  function cancelWarning() {
    setScanned(null);
    onCancel();
  }
```

and use `cancelWarning` as the cancel button's handler in place of `onCancel`.

- [ ] **Step 5: Verify the build**

Run: `bun run build`
Expected: succeeds.

Run: `bun run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/home/import-dialog.tsx
git commit -m "feat(import): extract text before creating the project, and warn on scans"
```

---

### Task 12: Editor distinguishes an empty page from an unextracted one

**Files:**
- Modify: `src/components/editor/center-panel.tsx:16-37,68-78`, `src/components/editor/editor.tsx:250-275`

**Interfaces:**
- Consumes: catalogue keys from Task 10.
- Produces: `CenterPanel` prop `noTextLayer: boolean`.

- [ ] **Step 1: Add the prop to `CenterPanel`**

In `src/components/editor/center-panel.tsx`, add to the props destructuring and the type:

```ts
  noTextLayer,
```

```ts
  /**
   * This page was extracted and holds no text — a scanned page, most likely.
   * Distinct from text simply not having arrived yet, which is transient.
   */
  noTextLayer: boolean;
```

- [ ] **Step 2: Choose the placeholder by state**

Replace the empty-text placeholder block:

```tsx
            {text === "" && (
              <div className="pointer-events-none absolute px-1 font-serif text-base text-ink-3 italic">
                {t(noTextLayer ? "center.noTextLayer" : "center.extracting")}
              </div>
            )}
```

The textarea below it is left exactly as it is. It stays editable on purpose: with no OCR, typing the page is the only way forward, and disabling it would remove that.

- [ ] **Step 3: Track the state in the editor**

In `src/components/editor/editor.tsx`, add state beside the existing text state:

```ts
  const [noTextLayer, setNoTextLayer] = useState(false);
```

In the page-load effect's success handler, set it from the page's own columns — `''` means extracted-and-empty, NULL means not yet extracted:

```ts
        const value = p.editedText ?? p.sourceText ?? "";
        savedTextRef.current = value;
        textPageRef.current = activePage;
        setText(value);
        setNoTextLayer(p.sourceText === "" && (p.editedText ?? "") === "");
        setSaved(true);
        setLoadError(null);
```

In the same effect's error handler, clear it, since nothing is known about the page:

```ts
        setNoTextLayer(false);
```

Pass it down where `CenterPanel` is rendered, beside the existing `pdfPath` prop:

```tsx
                noTextLayer={noTextLayer}
```

- [ ] **Step 4: Verify the build**

Run: `bun run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/center-panel.tsx src/components/editor/editor.tsx
git commit -m "feat(editor): tell an unreadable page apart from one still loading"
```

---

### Task 13: Self-repair on editor open

**Files:**
- Modify: `src/components/editor/editor.tsx`

**Interfaces:**
- Consumes: `ProjectDetail.pagesMissingText`, `savePageSourceText` (Task 9), `extractFromUrl` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Add the repair effect**

In `src/components/editor/editor.tsx`, add the imports:

```ts
import { convertFileSrc } from "@tauri-apps/api/core";
import { extractFromUrl } from "@/lib/extract-open";
import { savePageSourceText } from "@/lib/api";
```

`savePageSourceText` joins the existing `@/lib/api` import list rather than adding a second one.

Add the effect after the effect that loads the project:

```ts
  // Re-extract a project whose pages have no text. This covers a project
  // imported before extraction existed, and an interrupted write.
  //
  // The whole document is re-extracted, not just the missing pages: removing
  // running headers depends on seeing what repeats across every page, so a
  // page assembled alone would keep the header the rest of the book had
  // stripped. It costs about a second and leaves `edited_text` untouched.
  useEffect(() => {
    if (!project || project.pagesMissingText === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { pageTexts } = await extractFromUrl(convertFileSrc(project.pdfPath));
        if (cancelled) return;
        await savePageSourceText(project.id, pageTexts);
        if (cancelled) return;
        // Re-read the project so `pagesMissingText` drops to zero and the
        // active page picks up its new text.
        setProject(await getProject(project.id));
      } catch (e) {
        // A repair that fails leaves the pages as they were; the editor still
        // works and the empty placeholder still explains itself.
        console.error(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id, project?.pagesMissingText, project?.pdfPath]);
```

- [ ] **Step 2: Verify the build**

Run: `bun run build`
Expected: succeeds.

Run: `bun run test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor/editor.tsx
git commit -m "feat(editor): re-extract a project that is missing its text"
```

---

### Task 14: Manual verification

**Files:** none — this task runs the app.

- [ ] **Step 1: Launch**

Run: `bun run tauri dev`

- [ ] **Step 2: Work through the spec's manual acceptance criteria**

Criteria 3–13 of the spec, in order. The ones most likely to fail, and what to look for:

- **Criterion 5** is the substantive one. Import a textbook with a running header and a sidebar, go to a page that has both, and check four things at once: the header is gone, body paragraphs are reflowed rather than hard-wrapped, a box label sits above its own bullets, and the sidebar is present as a separate trailing block rather than spliced into a paragraph.
- **Criterion 6** — no page shows a doubled page number.
- **Criterion 8** — an image-only PDF raises the warning *before* any project exists. Confirm by cancelling, then checking the app data directory has no new project folder and the library has no new card.
- **Criterion 10** — type into an empty page, relaunch, and confirm the text is still there.
- **Criteria 11 and 12** — set one page's `source_text` to NULL with `sqlite3` against `enisma.db`, having first given that page an `edited_text`. Reopen the editor: every page's `source_text` should be repopulated, the repaired page's header stripped, and the edit still shown.
- **Criterion 13** — switch the interface language and confirm the new copy is translated.

- [ ] **Step 3: Record the outcome**

If every criterion passes, note it in the commit. If any fails, stop and report which — do not adjust thresholds to make a criterion pass without saying so, since the spec records what each one was chosen to demonstrate.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "test(extract): verify M3 acceptance criteria in the app"
```

---

## Self-Review

**Spec coverage.** Walked each spec section against the tasks:

| Spec section | Tasks |
| --- | --- |
| Extraction and assembly, steps 1–7 | 1 (dedupe, lines), 2 (blocks, order), 3 (reflow), 4 (furniture), 5 (compose) |
| Architecture — two front-end units | 1–5 (`extract-assemble.ts`), 6 (`extract.ts`, `extract-open.ts`) |
| Data layer — no migration, NULL vs `''`, `used_ocr` 0, `edited_text` untouched | 8 (import writes), 9 (replace path) |
| Data layer — emptiness thresholds | 5 |
| Command surface — all four rows | 7 (`read_pdf_bytes`), 8 (`import_project_cmd`), 9 (`save_page_source_text_cmd`); `save_page_text_cmd` unchanged by design |
| Import flow, steps 1–5 | 11 |
| Import flow — self-repair | 9 (`pagesMissingText`), 13 (the effect) |
| Frontend — import dialog | 11 |
| Frontend — center panel | 12 |
| Frontend — page panel unchanged | no task, deliberately |
| Frontend — four catalogues | 10 |
| Testing — assembly, driver, Rust | 1–6, 7–9 |
| Acceptance criteria | 14 |

One gap found and closed while reviewing: the spec's repair pass needs to know *whether* any page lacks text, and `ProjectDetail` carried no such field — so `pages_missing_text` and its `get_project` test were added to Task 9, rather than having the editor fetch every page to find out.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every code step carries the actual code. The one intentionally underspecified item is the translated `message` values in Task 10, which require a human translator and are marked as such; their keys, contexts, and ICU placeholders are all given exactly.

**Type consistency.** Checked the names that cross task boundaries: `RawItem`, `Line`, `Block` (Tasks 1–2, used in 3–5); `assembleDocument`, `isEmptyPage`, `looksScanned` (Task 5, consumed in 6); `ExtractResult.pageTexts` / `.emptyPages` / `.looksScanned` (Task 6, consumed in 11 and 13); `page_texts` as the Rust parameter name throughout Tasks 8–9 and `pageTexts` as its camelCase IPC counterpart in `api.ts`; `pages_missing_text` in Rust against `pagesMissingText` in TypeScript (Task 9, consumed in 13). `extractFromBytes` is used only by import, `extractFromUrl` only by repair, and both live in `extract-open.ts`.
