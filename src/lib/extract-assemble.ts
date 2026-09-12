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
