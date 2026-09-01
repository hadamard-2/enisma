import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { formatShortcut, MOD } from "@/lib/platform";
import { PdfCanvas } from "./pdf-canvas";

export type View = "pdf" | "split" | "edit";

export function CenterPanel({
  page,
  pdfPath,
  text,
  setText,
  saved,
  view,
}: {
  page: number;
  pdfPath: string;
  text: string;
  setText: (t: string) => void;
  saved: boolean;
  view: View;
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
            <PdfCanvas url={convertFileSrc(pdfPath)} page={page} />
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
              <span className={saved ? "text-ink-3" : "text-amber-ink"}>
                {saved ? "saved" : "unsaved changes"}
              </span>
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface px-5 py-4 shadow-paper-sm">
              {text === "" && (
                <div className="pointer-events-none absolute px-1 font-serif text-base text-ink-3 italic">
                  No extracted text yet — type here, or wait for extraction.
                </div>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent font-serif text-base leading-relaxed text-ink outline-none"
                style={{ letterSpacing: "0.005em" }}
              />
              <div className="mt-2.5 flex justify-between border-t border-dashed border-line pt-2.5 text-[11px] text-ink-3">
                <span>
                  {wordCount} words · ~{seconds}s spoken
                </span>
                <span className="inline-flex items-center gap-2.5">
                  <Kbd>{formatShortcut(MOD, "Z")}</Kbd> undo
                  <Kbd>{formatShortcut(MOD, "S")}</Kbd> save
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
