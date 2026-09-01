import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

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
 */
const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;
const PDFJS_ASSET_URLS = {
  wasmUrl: asset("wasm"),
  cMapUrl: asset("cmaps"),
  standardFontDataUrl: asset("standard_fonts"),
};

export function PdfCanvas({ url, page }: { url: string; page: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the document once per URL. The whole file is delivered in one
  // response: pdf.js only negotiates range requests over http(s), and the
  // asset protocol this URL uses is neither. That sets a memory ceiling — the
  // PDF is buffered whole on the way through — which is a known limit here.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const loading = pdfjs.getDocument({ url, ...PDFJS_ASSET_URLS });
    loading.promise.then(
      (d) => {
        // PDFDocumentProxy has no destroy() of its own in v6; loading.destroy()
        // below already tears down the underlying transport in this case.
        if (cancelled) return;
        setDoc(d);
      },
      (e: unknown) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
      setDoc(null);
      loading.destroy();
    };
  }, [url]);

  // Render the active page, cancelling any render still in flight. Holding a
  // paging key otherwise queues overlapping renders onto one canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!doc || !canvas || !container) return;

    let cancelled = false;
    taskRef.current?.cancel();

    doc.getPage(page).then((p) => {
      if (cancelled) return;

      const dpr = window.devicePixelRatio || 1;
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({
        scale: ((container.clientWidth || base.width) / base.width) * dpr,
      });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;

      const task = p.render({ canvas, viewport });
      taskRef.current = task;
      task.promise.catch((e: unknown) => {
        // A cancelled render rejects with RenderingCancelledException; that
        // is expected while paging fast and must not surface as an error.
        if (!cancelled && !(e instanceof pdfjs.RenderingCancelledException)) {
          setError(String(e));
        }
      });
    });

    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [doc, page]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface shadow-paper-sm"
    >
      {error ? (
        <div className="p-6 text-[12.5px] text-amber-ink">Could not render this PDF: {error}</div>
      ) : (
        <canvas ref={canvasRef} className="mx-auto block" />
      )}
    </div>
  );
}
