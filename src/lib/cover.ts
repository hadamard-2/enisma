import type { CoverPalette } from "./data";

const PALETTES: CoverPalette[] = ["warm", "teal", "rose", "amber", "slate"];

/**
 * Pick a cover palette from the project id.
 *
 * Must stay a plain deterministic function of the string — FNV-1a here. Any
 * seeded, time-dependent, or platform-dependent hash would change a book's
 * colour between launches, which fails silently and looks like nothing.
 */
export function coverForId(id: string): CoverPalette {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PALETTES[h % PALETTES.length]!;
}
