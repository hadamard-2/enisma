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
