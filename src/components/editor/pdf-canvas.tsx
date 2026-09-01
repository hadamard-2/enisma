import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

// Bundled by Vite from the installed package; no network fetch.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export function PdfCanvas({ url, page }: { url: string; page: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const taskRef = useRef<RenderTask | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the document once per URL. Range requests are on by default, so a
  // large scan is fetched in chunks rather than all at once.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const loading = pdfjs.getDocument({ url });
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
