/**
 * Plain, case-insensitive text search for the page find bar and book search.
 *
 * Pure and in its own module so it can be tested: vitest only picks up
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 *
 * Offsets are UTF-16 indices into the original text, which is what a
 * textarea's `setSelectionRange` takes.
 */

export type Match = { start: number; end: number };

/**
 * Every non-overlapping occurrence of `query` in `text`, ignoring case.
 *
 * Lowercases one character at a time, and keeps a character's original span,
 * because lowercasing a whole string can change its length (İ becomes two
 * characters) and would shift every offset after it. A character whose
 * lowercase form is longer than itself is compared as it is.
 */
export function findAll(text: string, query: string): Match[] {
  if (!query) return [];
  const fold = (s: string) =>
    Array.from(s, (ch) => {
      const lo = ch.toLowerCase();
      return lo.length === ch.length ? lo : ch;
    }).join("");
  const hay = fold(text);
  const needle = fold(query);
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) return out;
    out.push({ start: i, end: i + needle.length });
    from = i + needle.length;
  }
}

export type Snippet = { before: string; match: string; after: string; start: number; end: number };

/** Characters of context either side of a match in a result list. */
export const SNIPPET_CONTEXT = 40;

/** A match with a little of its line either side, trimmed at line breaks. */
export function snippet(text: string, m: Match, context: number = SNIPPET_CONTEXT): Snippet {
  let a = Math.max(0, m.start - context);
  let b = Math.min(text.length, m.end + context);
  const nlBefore = text.lastIndexOf("\n", m.start - 1);
  if (nlBefore >= a) a = nlBefore + 1;
  const nlAfter = text.indexOf("\n", m.end);
  if (nlAfter !== -1 && nlAfter < b) b = nlAfter;
  return {
    before: (a > 0 && text[a - 1] !== "\n" ? "…" : "") + text.slice(a, m.start).trimStart(),
    match: text.slice(m.start, m.end),
    after: text.slice(m.end, b).trimEnd() + (b < text.length && text[b] !== "\n" ? "…" : ""),
    start: m.start,
    end: m.end,
  };
}

export type PageResults = { pageNo: number; snippets: Snippet[] };

/** Every page with at least one match, in page order. */
export function searchPages(
  pages: readonly { pageNo: number; text: string }[],
  query: string,
): PageResults[] {
  if (!query.trim()) return [];
  return pages
    .map((p) => ({ pageNo: p.pageNo, snippets: findAll(p.text, query).map((m) => snippet(p.text, m)) }))
    .filter((r) => r.snippets.length > 0);
}
