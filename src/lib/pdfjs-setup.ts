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
