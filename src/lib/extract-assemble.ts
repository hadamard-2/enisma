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
