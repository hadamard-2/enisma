/**
 * Validating a proposed project title.
 *
 * Pure and in its own module so it can be tested: vitest's `include` is
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 * The rename dialog is wiring; this is the part with rules in it.
 */

/** Whether a proposed title can be saved, and the exact text to save. */
export type TitleCheck = { ok: true; title: string } | { ok: false };

/**
 * Check a proposed title against the one the project already has.
 *
 * A title is saveable when it holds visible text and differs from the current
 * one. Both sides are trimmed first, so re-saving with stray surrounding space
 * is a no-op rather than a write that bumps `updated_at` for nothing. Case is
 * significant: correcting a project's capitalisation is a real rename.
 */
export function validateTitle(proposed: string, current: string): TitleCheck {
  const title = proposed.trim();
  if (title === "") return { ok: false };
  if (title === current.trim()) return { ok: false };
  return { ok: true, title };
}
