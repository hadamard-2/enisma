import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useDefaultLayout } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { formatShortcut, MOD, SHIFT_KEY } from "@/lib/platform";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
  noTextLayer,
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
  /**
   * This page was extracted and holds no text — a scanned page, most likely.
   * Distinct from text simply not having arrived yet, which is transient.
   */
  noTextLayer: boolean;
}) {
  const { t } = useTranslation();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.round(text.length / 14);
  const split = useDefaultLayout({
    id: "hb-center-split-v1",
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  });

  const pdfPane = (
    <div className={cn("flex h-full min-w-0 flex-col pt-13 pb-3", view === "split" ? "pl-3" : "px-3")}>
      <PdfViewer url={convertFileSrc(pdfPath)} page={page} />
    </div>
  );

  const textPane = (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col pt-13 pb-3",
        view === "split" ? "pr-3" : "px-3",
      )}
    >
      {/* A container, so the footer below reacts to this pane's own width —
          which is what actually runs out, whether the window is small or the
          split has been dragged over. */}
      <div className="@container relative flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface px-5 py-4 shadow-paper-sm">
        {loadError ? (
          // No text was loaded, so there is no baseline to edit against.
          // Showing an editable box here would invite typing that cannot
          // be attributed to a page, and so cannot be saved.
          <div className="min-h-0 flex-1 px-1 text-[12.5px] text-amber-ink">
            {t("center.loadError", { page, error: loadError })}
          </div>
        ) : (
          <>
            {text === "" && (
              <div className="pointer-events-none absolute px-1 font-serif text-base text-ink-3 italic">
                {t(noTextLayer ? "center.noTextLayer" : "center.extracting")}
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
            {t("center.stats", { words: wordCount, seconds })}
            {/* Only ever shown when something is off: "saved" is the normal
                state and doesn't need saying. */}
            {(loadError || !saved) && (
              <span className="text-amber-ink">
                {" · "}
                {t(loadError ? "center.notLoaded" : "center.unsavedChanges")}
              </span>
            )}
          </span>
          <span className="inline-flex items-center gap-2.5">
            {/* The hints are the expendable half of this row: they go once the
                pane is too narrow to hold them beside the button. */}
            <span className="inline-flex items-center gap-2.5 @max-[510px]:hidden">
              <Kbd>{formatShortcut(MOD, "Z")}</Kbd> {t("center.undoHint")}
              <Kbd>{formatShortcut(MOD, SHIFT_KEY, "Z")}</Kbd> {t("center.redoHint")}
              <Kbd>{formatShortcut(MOD, "S")}</Kbd> {t("center.saveHint")}
            </span>
            <button
              onClick={onToggleDone}
              aria-pressed={done}
              title={t(done ? "center.pageDoneTooltipOn" : "center.pageDoneTooltipOff")}
              className={cn(
                "ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 font-medium transition-colors",
                done
                  ? "border-teal bg-teal text-surface hover:bg-teal/90"
                  : "border-line bg-surface text-ink-2 hover:bg-paper-3 hover:text-ink",
              )}
            >
              <Check size={12} strokeWidth={2.2} />
              {t("center.pageDone")}
            </button>
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <section className="flex h-full min-w-0 flex-col bg-paper">
      {view === "split" ? (
        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={split.defaultLayout}
          onLayoutChanged={split.onLayoutChanged}
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="pdf" defaultSize="50%" minSize="25%">
            {pdfPane}
          </ResizablePanel>
          <SplitHandle />
          <ResizablePanel id="text" defaultSize="50%" minSize="25%">
            {textPane}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">{view === "pdf" ? pdfPane : textPane}</div>
      )}
    </section>
  );
}

/**
 * The gap between the two panes doubles as the drag target. It stays blank
 * until the pointer is over it (or it's being dragged/focused), then shows a
 * grip bar. The library sets `data-separator` from its own hit-testing.
 */
function SplitHandle() {
  return (
    <ResizableHandle className="group w-2 bg-transparent pt-13 pb-3 focus-visible:ring-0">
      <div className="h-10 w-1 rounded-full bg-line-2 opacity-0 transition-opacity group-data-[separator=active]:bg-ink-4 group-data-[separator=active]:opacity-100 group-data-[separator=focus]:opacity-100 group-data-[separator=hover]:opacity-100" />
    </ResizableHandle>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-line border-b-2 bg-surface px-1.5 py-px font-mono text-[10.5px] leading-tight text-ink-3">
      {children}
    </span>
  );
}
