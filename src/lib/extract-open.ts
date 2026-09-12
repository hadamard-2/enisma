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
