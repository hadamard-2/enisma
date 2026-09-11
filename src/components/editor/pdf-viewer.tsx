import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { formatShortcut, MOD } from "@/lib/platform";

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

/** Padding around the page, in CSS px. */
const PAD = 12;
/** Scrollbar thickness, in CSS px; matches `::-webkit-scrollbar` in App.css. */
const SCROLLBAR = 10;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const ZOOM_KEY_STEP = 1.2;
/** The canvas re-renders this long after the last zoom/resize step. */
const RENDER_SETTLE_MS = 150;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * Single-page PDF viewer: fit-to-width at 100%, zoomable with Ctrl/Cmd + wheel
 * or Ctrl/Cmd + =/-/0, centred when the page is smaller than the viewport, and
 * carrying pdf.js's text layer so the page's own text can be selected.
 */
export function PdfViewer({ url, page }: { url: string; page: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasHolder = useRef<HTMLDivElement | null>(null);
  const textHolder = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  // Scroll position to restore once a zoom change has been laid out.
  const anchorRef = useRef<{ fx: number; fy: number; ax: number; ay: number } | null>(null);

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
        if (!cancelled) setDoc(d);
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

  // Fetch the active page's proxy; its size drives layout before any render.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc.getPage(page).then(
      (p) => {
        if (!cancelled) setPdfPage(p);
      },
      (e: unknown) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  // Start each page at its top-left.
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [page]);

  // Track the width fit-to-width is computed against: the scroller's outer
  // width less a scrollbar, whether or not one is showing. Using the live
  // inner width instead feeds back — near the fit boundary the page is too
  // tall, a scrollbar appears, the width shrinks, the page fits, the
  // scrollbar goes, the width grows — and the page flips between two sizes
  // every frame. (`scrollbar-gutter: stable` would be the CSS fix, but
  // WebKitGTK reports it as applied without reserving the gutter.)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, el.offsetWidth - SCROLLBAR));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const base = pdfPage?.getViewport({ scale: 1 });
  const scale = base && width ? (zoom * Math.max(width - 2 * PAD, 50)) / base.width : 0;

  // Rasterise at a scale that trails the layout scale, so a burst of zoom
  // steps or a panel drag stretches the current bitmap instead of restarting
  // the render on every step. A new page renders at once.
  const [renderScale, setRenderScale] = useState(0);
  const renderedPageRef = useRef<PDFPageProxy | null>(null);
  useEffect(() => {
    if (!renderScale || renderedPageRef.current !== pdfPage) {
      renderedPageRef.current = pdfPage;
      setRenderScale(scale);
      return;
    }
    const t = window.setTimeout(() => setRenderScale(scale), RENDER_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [scale, renderScale, pdfPage]);

  // Render into a fresh canvas and text layer, swapping each in only when it
  // finishes, so the previous page (stretched by CSS) stays up during a
  // re-render instead of flashing blank. Cancelling any render still in
  // flight keeps a held paging key from queueing overlapping renders.
  useEffect(() => {
    const canvasDiv = canvasHolder.current;
    const textDiv = textHolder.current;
    if (!pdfPage || !renderScale || !canvasDiv || !textDiv) return;
    let cancelled = false;

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    const viewport = pdfPage.getViewport({ scale: renderScale * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = "absolute inset-0 size-full";
    const task = pdfPage.render({ canvas, viewport });
    task.promise.then(
      () => {
        if (!cancelled) canvasDiv.replaceChildren(canvas);
      },
      (e: unknown) => {
        // A cancelled render rejects with RenderingCancelledException; that
        // is expected while paging or zooming and is not an error.
        if (!cancelled && !(e instanceof pdfjs.RenderingCancelledException)) {
          setError(String(e));
        }
      },
    );

    // Selectable text. Scanned pages carry no text of their own, so this only
    // yields something on born-digital or already-OCR'd PDFs.
    const layer = document.createElement("div");
    layer.className = "textLayer";
    const text = new pdfjs.TextLayer({
      textContentSource: pdfPage.streamTextContent(),
      container: layer,
      viewport: pdfPage.getViewport({ scale: renderScale }),
    });
    // pdf.js measures the engine's minimum font size as the height of a 1px
    // "X" and writes it to --min-font-size; every run's font size is
    // multiplied by it and its transform scaled by its reciprocal. WebKitGTK
    // (Tauri's Linux webview) measures 0, which collapses every run to 0×0 —
    // present but impossible to select. A non-positive value can only mean
    // "no minimum", which is 1.
    if (!(parseFloat(layer.style.getPropertyValue("--min-font-size")) > 0)) {
      layer.style.setProperty("--min-font-size", "1");
    }
    text.render().then(
      () => {
        if (!cancelled) textDiv.replaceChildren(layer);
      },
      (e: unknown) => {
        if (!cancelled) console.error("PDF text layer failed", e);
      },
    );

    return () => {
      cancelled = true;
      task.cancel();
      text.cancel();
    };
  }, [pdfPage, renderScale]);

  // A different page must not show the last page's bitmap or text meanwhile.
  useLayoutEffect(() => {
    canvasHolder.current?.replaceChildren();
    textHolder.current?.replaceChildren();
  }, [pdfPage]);

  // Zoom, keeping the point under the anchor (pointer, or viewport centre)
  // fixed on screen.
  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const root = scrollRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const ax = clientX === undefined ? root.clientWidth / 2 : clientX - r.left;
    const ay = clientY === undefined ? root.clientHeight / 2 : clientY - r.top;
    anchorRef.current = {
      fx: (root.scrollLeft + ax) / root.scrollWidth,
      fy: (root.scrollTop + ay) / root.scrollHeight,
      ax,
      ay,
    };
    setZoom((z) => clampZoom(z * factor));
  }, []);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    const a = anchorRef.current;
    if (!root || !a) return;
    anchorRef.current = null;
    root.scrollLeft = a.fx * root.scrollWidth - a.ax;
    root.scrollTop = a.fy * root.scrollHeight - a.ay;
  }, [zoom]);

  // Ctrl/Cmd + wheel (and trackpad pinch, which arrives as a ctrl wheel).
  // Registered natively: React's wheel listener is passive and cannot stop
  // the page from scrolling.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    function onWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    }
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // Ctrl/Cmd + =/+, -, 0.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") zoomBy(ZOOM_KEY_STEP);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_KEY_STEP);
      else if (e.key === "0") zoomBy(1 / zoom);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomBy, zoom]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-paper-2 shadow-paper-sm">
      <div ref={scrollRef} className="scroll-inset min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-6 text-[12.5px] text-amber-ink">Could not render this PDF: {error}</div>
        ) : (
          // w-max/min-w-full and min-h-full: at least the viewport's size, so
          // a small page centres in it, and grows with a large one so it
          // scrolls rather than overflowing to the unreachable top or left.
          <div className="grid min-h-full w-max min-w-full place-items-center" style={{ padding: PAD }}>
            {base && scale > 0 && (
              <div
                className="relative bg-white shadow-paper-sm"
                style={
                  {
                    width: Math.floor(base.width * scale),
                    height: Math.floor(base.height * scale),
                    // Read by pdf.js's text layer to size and place its runs.
                    "--total-scale-factor": scale * pdfPage!.userUnit,
                    "--scale-round-x": "1px",
                    "--scale-round-y": "1px",
                  } as React.CSSProperties
                }
              >
                <div ref={canvasHolder} />
                <div ref={textHolder} />
              </div>
            )}
          </div>
        )}
      </div>
      {zoom !== 1 && (
        <button
          onClick={() => zoomBy(1 / zoom)}
          title={`Reset zoom (${formatShortcut(MOD, "0")})`}
          className="absolute bottom-3 left-3 cursor-pointer rounded-md bg-ink/75 px-2 py-0.5 font-mono text-[10.5px] text-paper transition-colors hover:bg-ink"
        >
          {Math.round(zoom * 100)}%
        </button>
      )}
    </div>
  );
}
