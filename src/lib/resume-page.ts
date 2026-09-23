/**
 * Which page the editor opens a project on.
 *
 * Pure and in its own module so it can be tested: vitest only picks up
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 */

type Page = { pageNo: number; done: boolean };

/**
 * The page the user last left, if the project still has it; otherwise the
 * first page not yet marked done, and page 1 if every page is.
 *
 * A remembered page is only ever a hint. It is checked against the pages the
 * project actually has rather than trusted, because nothing ties the two
 * together in storage.
 */
export function resumePage(pages: readonly Page[], lastPage: number | null): number {
  if (lastPage !== null && pages.some((p) => p.pageNo === lastPage)) return lastPage;
  return pages.find((p) => !p.done)?.pageNo ?? 1;
}
