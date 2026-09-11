import { convertFileSrc } from "@tauri-apps/api/core";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatShortcut, MOD, SHIFT_KEY } from "@/lib/platform";
import { PdfViewer } from "./pdf-viewer";

export type View = "pdf" | "split" | "edit";

export function CenterPanel({
  page,
  pdfPath,
  text,
  setText,
  saved,
  loadError,
  view,
  done,
  onToggleDone,
}: {
  page: number;
  pdfPath: string;
  text: string;
  setText: (t: string) => void;
  saved: boolean;
  /** Non-null when this page's text could not be read; editing is blocked. */
  loadError: string | null;
  view: View;
  /** Whether the active page is marked done. */
  done: boolean;
  onToggleDone: () => void;
}) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.round(text.length / 14);

  return (
    <section className="flex h-full min-w-0 flex-col bg-paper">
      <div className="flex min-h-0 flex-1">
        {view !== "edit" && (
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col pt-13 pb-3",
              view === "split" ? "pr-2 pl-3" : "px-3",
            )}
          >
            <div className="mb-2 font-mono text-[10.5px] tracking-widest text-ink-3 uppercase">
              PDF preview · source page {page}
            </div>
            <PdfViewer url={convertFileSrc(pdfPath)} page={page} />
          </div>
        )}

        {view !== "pdf" && (
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col pt-13 pb-3",
              view === "split" ? "pr-3 pl-2" : "px-3",
            )}
          >
            <div className="mb-2 flex justify-between font-mono text-[10.5px] tracking-widest uppercase">
              <span className="text-ink-3">Extracted text · editable</span>
              <span
                className={saved && !loadError ? "text-ink-3" : "text-amber-ink"}
              >
                {loadError ? "not loaded" : saved ? "saved" : "unsaved changes"}
              </span>
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface px-5 py-4 shadow-paper-sm">
              {loadError ? (
                // No text was loaded, so there is no baseline to edit against.
                // Showing an editable box here would invite typing that cannot
                // be attributed to a page, and so cannot be saved.
                <div className="min-h-0 flex-1 px-1 text-[12.5px] text-amber-ink">
                  Could not load the text for page {page}: {loadError}
                </div>
              ) : (
                <>
                  {text === "" && (
                    <div className="pointer-events-none absolute px-1 font-serif text-base text-ink-3 italic">
                      No extracted text yet — type here, or wait for extraction.
                    </div>
                  )}
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    className="min-h-0 flex-1 resize-none border-0 bg-transparent font-serif text-base leading-relaxed text-ink outline-none! scroll-inset"
                    style={{ letterSpacing: "0.005em" }}
                  />
                </>
              )}
              <div className="mt-2.5 flex justify-between border-t border-dashed border-line pt-2.5 text-[11px] text-ink-3">
                <span>
                  {wordCount} words · ~{seconds}s spoken
                </span>
                <span className="inline-flex items-center gap-2.5">
                  <Kbd>{formatShortcut(MOD, "Z")}</Kbd> Undo
                  <Kbd>{formatShortcut(MOD, SHIFT_KEY, "Z")}</Kbd> Redo
                  <Kbd>{formatShortcut(MOD, "S")}</Kbd> Save
                  <button
                    onClick={onToggleDone}
                    aria-pressed={done}
                    title={done ? "Page is done — click to reopen" : "Mark this page done"}
                    className={cn(
                      "ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 font-medium transition-colors",
                      done
                        ? "border-teal bg-teal text-surface hover:bg-teal/90"
                        : "border-line bg-surface text-ink-2 hover:bg-paper-3 hover:text-ink",
                    )}
                  >
                    <Check size={12} strokeWidth={2.2} />
                    Page done
                  </button>
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-line border-b-2 bg-surface px-1.5 py-px font-mono text-[10.5px] leading-tight text-ink-3">
      {children}
    </span>
  );
}
