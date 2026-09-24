import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useDefaultLayout } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { formatShortcut, MOD, SHIFT_KEY } from "@/lib/platform";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { placeholderFor } from "@/lib/page-placeholder";
import { TextHistory, type TextState } from "@/lib/text-history";
import { findAll, type Match } from "@/lib/text-search";

/**
 * Asks a text field to undo or redo through the app's own history. The Edit
 * menu dispatches it on the field it refocuses; the field cancels it when it
 * handled the request, and the menu falls back to the native command only if
 * nobody did — which keeps plain inputs like the rename field working.
 */
export const HISTORY_EVENT = "enisma:history";

/**
 * Asks the text pane to select a range on a page, once that page's text has
 * loaded. `query` is what should be there, so a request is only applied to the
 * text it was made for — and waits, rather than selecting the wrong span,
 * while the page is still loading. `nonce` makes a repeat request distinct.
 */
export type SelectRequest = { page: number; start: number; end: number; query: string; nonce: number };
import { PdfViewer } from "./pdf-viewer";

export type View = "pdf" | "split" | "edit";

export function CenterPanel({
  page,
  pdfPath,
  text,
  setText,
  loadError,
  saveError,
  view,
  done,
  onToggleDone,
  sourceText,
  repairing,
  repairError,
  findOpen,
  findFocus,
  onCloseFind,
  selectRequest,
  textPage,
}: {
  page: number;
  pdfPath: string;
  text: string;
  setText: (t: string) => void;
  /** Non-null when this page's text could not be read; editing is blocked. */
  loadError: string | null;
  /** Non-null when this page's last edit could not be written; untranslated. */
  saveError: string | null;
  view: View;
  /** Whether the active page is marked done. */
  done: boolean;
  onToggleDone: () => void;
  /** This page's stored extraction: null = never extracted, '' = nothing found. */
  sourceText: string | null;
  /** Whether a re-extraction is in flight for this project. */
  repairing: boolean;
  /** Non-null when the re-extraction failed; the text is untranslated. */
  repairError: string | null;
  /** Whether the page find bar is showing. */
  findOpen: boolean;
  /** Bumped by every Ctrl+F, so pressing it again refocuses the field. */
  findFocus: number;
  onCloseFind: () => void;
  selectRequest: SelectRequest | null;
  /**
   * The page `text` was actually loaded from. Runs behind `page` for a moment
   * after a page change, while the new page's text is still being read.
   */
  textPage: number | null;
}) {
  const { t } = useTranslation();
  const { areaRef, onChange, onSelect, onKeyDown } = usePageHistory(page, text, setText);

  // Page find. Owned here rather than in the bar because the highlights are
  // drawn behind the textarea, which the bar does not contain.
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const matches = useMemo(
    () => (findOpen ? findAll(text, findQuery) : []),
    [findOpen, text, findQuery],
  );
  const current = matches.length === 0 ? -1 : Math.min(findIndex, matches.length - 1);
  // Matches belong to the page they were found on.
  useEffect(() => setFindIndex(0), [page]);

  // A result picked in book search lands here once its page has loaded, and
  // is shown the way page find shows a match: the bar opens with the same
  // query (the editor opens it), and the picked match becomes the current one.
  const appliedRef = useRef<number | null>(null);
  useEffect(() => {
    const r = selectRequest;
    if (!r || r.page !== page || textPage !== r.page || appliedRef.current === r.nonce) return;
    if (text.slice(r.start, r.end).toLowerCase() !== r.query.toLowerCase()) return;
    appliedRef.current = r.nonce;
    setFindQuery(r.query);
    setFindIndex(Math.max(0, findAll(text, r.query).findIndex((m) => m.start === r.start)));
  }, [selectRequest, page, text, textPage]);
  const placeholder = placeholderFor({ sourceText, editedText: text, repairing });
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
        {findOpen && !loadError && (
          <FindBar
            query={findQuery}
            setQuery={(q) => {
              setFindQuery(q);
              setFindIndex(0);
            }}
            matches={matches}
            current={current}
            setCurrent={setFindIndex}
            focus={findFocus}
            onClose={() => {
              const el = areaRef.current;
              const m = current >= 0 ? matches[current] : undefined;
              onCloseFind();
              // Leave the match selected, ready to edit.
              if (el && m) revealInTextarea(el, m.start, m.end);
            }}
          />
        )}
        {loadError ? (
          // No text was loaded, so there is no baseline to edit against.
          // Showing an editable box here would invite typing that cannot
          // be attributed to a page, and so cannot be saved.
          <div className="min-h-0 flex-1 px-1 text-[12.5px] text-amber-ink">
            {t("center.loadError", { page, error: loadError })}
          </div>
        ) : (
          <>
            {placeholder && (
              <div className="pointer-events-none absolute px-1 font-serif text-base text-ink-3 italic">
                {t(`center.${placeholder}`)}
              </div>
            )}
            <div className="relative -mr-3.75 min-h-0 flex-1">
              {matches.length > 0 && (
                <FindHighlights
                  text={text}
                  matches={matches}
                  current={current}
                  areaRef={areaRef}
                />
              )}
              <textarea
                ref={areaRef}
                value={text}
                onChange={onChange}
                onSelect={onSelect}
                onKeyDown={onKeyDown}
                className={cn(TEXT_LAYOUT, "absolute inset-0 z-10 h-full w-full resize-none border-0 bg-transparent text-ink outline-none! scroll-inset")}
                style={{ letterSpacing: TEXT_LETTER_SPACING }}
              />
            </div>
          </>
        )}
        {/* A failed repair is the user's business: without this the page just
            sits there empty with no sign that anything was attempted. */}
        {repairError && (
          <div className="mt-2.5 px-1 text-[12.5px] text-amber-ink">
            {t("center.repairError", { error: repairError })}
          </div>
        )}
        <div className="mt-2.5 flex justify-between border-t border-dashed border-line pt-2.5 text-[11px] text-ink-3">
          <span>
            {t("center.stats", { words: wordCount, seconds })}
            {/* Only real failures are flagged. Autosave means an edit is
                normally on disk half a second after the last keystroke, so a
                merely-pending save is not worth announcing — it would flash
                amber on every pause in typing. A rejected write is different:
                nothing retries it on its own. */}
            {loadError ? (
              <span className="text-amber-ink">
                {" · "}
                {t("center.notLoaded")}
              </span>
            ) : (
              saveError && (
                // The backend's own words, untranslated, for whoever looks.
                <span className="text-amber-ink" title={saveError}>
                  {" · "}
                  {t("center.saveFailed")}
                </span>
              )
            )}
          </span>
          <span className="inline-flex items-center gap-2.5">
            {/* The hints are the expendable half of this row: they go once the
                pane is too narrow to hold them beside the button. */}
            <span className="inline-flex items-center gap-2.5 @max-[510px]:hidden">
              <Kbd>{formatShortcut(MOD, "Z")}</Kbd> {t("center.undoHint")}
              <Kbd>{formatShortcut(MOD, SHIFT_KEY, "Z")}</Kbd> {t("center.redoHint")}
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

/**
 * The page editor's undo/redo, bound to one page at a time.
 *
 * Any text this panel did not produce itself — a page load, a repair landing —
 * starts the history over, as does a page change, so undo can never reach
 * across into another page's text.
 */
function usePageHistory(page: number, text: string, setText: (t: string) => void) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRef = useRef<TextHistory | null>(null);
  historyRef.current ??= new TextHistory(at(text, 0));
  // The last value this panel handed to `setText`, to tell our own edits
  // apart from text that arrived from outside.
  const ownRef = useRef(text);
  const pageRef = useRef(page);
  // Where the caret goes once an undone or redone value has rendered.
  const caretRef = useRef<TextState | null>(null);

  useEffect(() => {
    if (page !== pageRef.current || text !== ownRef.current) {
      pageRef.current = page;
      ownRef.current = text;
      historyRef.current!.reset(at(text, 0));
    }
  }, [page, text]);

  useLayoutEffect(() => {
    const c = caretRef.current;
    const el = areaRef.current;
    if (!c || !el || el.value !== c.value) return;
    caretRef.current = null;
    el.setSelectionRange(c.selectionStart, c.selectionEnd);
  });

  function apply(state: TextState | null) {
    if (!state) return;
    ownRef.current = state.value;
    caretRef.current = state;
    setText(state.value);
  }

  function step(action: "undo" | "redo") {
    const h = historyRef.current!;
    apply(action === "undo" ? h.undo() : h.redo());
  }

  // The Edit menu's Undo and Redo arrive as an event on this field.
  useEffect(() => {
    function onHistory(e: Event) {
      if (e.target !== areaRef.current) return;
      const action = (e as CustomEvent<string>).detail;
      if (action !== "undo" && action !== "redo") return;
      e.preventDefault();
      step(action);
    }
    window.addEventListener(HISTORY_EVENT, onHistory, true);
    return () => window.removeEventListener(HISTORY_EVENT, onHistory, true);
  });

  return {
    areaRef,
    onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const el = e.currentTarget;
      historyRef.current!.record(
        { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd },
        performance.now(),
      );
      ownRef.current = el.value;
      setText(el.value);
    },
    onSelect(e: React.SyntheticEvent<HTMLTextAreaElement>) {
      // Same text, new caret: remembered so an undo puts the caret back.
      const el = e.currentTarget;
      historyRef.current!.record(
        { value: el.value, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd },
        performance.now(),
      );
    },
    onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        step(e.shiftKey ? "redo" : "undo");
      } else if (key === "y" && !e.shiftKey) {
        e.preventDefault();
        step("redo");
      }
    },
  };
}

function at(value: string, caret: number): TextState {
  return { value, selectionStart: caret, selectionEnd: caret };
}

/**
 * Select a range in the textarea and scroll it into view.
 *
 * Focusing is what makes the webview scroll a selection into view, so the
 * field is focused around the selection; callers that want focus elsewhere
 * take it back afterwards.
 */
function revealInTextarea(el: HTMLTextAreaElement, start: number, end: number) {
  el.blur();
  el.focus();
  el.setSelectionRange(start, end);
}

/**
 * Everything that decides where the textarea's text wraps. The highlight
 * layer must use exactly the same, or its marks drift off the words they
 * mark — including the scroll gutter, which is why both always reserve one.
 */
const TEXT_LAYOUT = "overflow-y-scroll font-serif text-base leading-relaxed whitespace-pre-wrap break-words";
const TEXT_LETTER_SPACING = "0.005em";

/**
 * The find highlights: a copy of the text laid out exactly like the textarea,
 * behind it, with the text itself invisible and only the marks showing.
 *
 * A textarea cannot style part of its own content, and its native selection
 * is not drawn while focus is in the find field — which is why stepping
 * through matches used to show nothing at all.
 */
function FindHighlights({
  text,
  matches,
  current,
  areaRef,
}: {
  text: string;
  matches: Match[];
  current: number;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);

  // Follow the textarea's scrolling.
  useEffect(() => {
    const area = areaRef.current;
    const layer = layerRef.current;
    if (!area || !layer) return;
    const sync = () => {
      layer.scrollTop = area.scrollTop;
    };
    sync();
    area.addEventListener("scroll", sync);
    return () => area.removeEventListener("scroll", sync);
  }, [areaRef]);

  // Bring the current match into view when it changes.
  useLayoutEffect(() => {
    const area = areaRef.current;
    const layer = layerRef.current;
    const mark = layer?.querySelector<HTMLElement>("[data-current]");
    if (!area || !layer || !mark) return;
    const top = mark.offsetTop;
    const bottom = top + mark.offsetHeight;
    if (top < area.scrollTop || bottom > area.scrollTop + area.clientHeight) {
      area.scrollTop = Math.max(0, top - area.clientHeight / 3);
    }
    layer.scrollTop = area.scrollTop;
  }, [current, matches, areaRef]);

  const parts: React.ReactNode[] = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <mark
        key={i}
        data-current={i === current ? "" : undefined}
        className={cn(
          "rounded-[2px] text-transparent",
          i === current ? "bg-teal/40 ring-1 ring-teal/60" : "bg-teal-soft",
        )}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  });
  parts.push(text.slice(at));

  return (
    <div
      ref={layerRef}
      aria-hidden
      className={cn(TEXT_LAYOUT, "find-layer pointer-events-none absolute inset-0 text-transparent")}
      style={{ letterSpacing: TEXT_LETTER_SPACING }}
    >
      {parts}
      {/* A textarea always leaves room for a line after a trailing newline. */}
      {"\n "}
    </div>
  );
}

/**
 * The page's find bar: floats at the top right of the text pane. Enter and
 * Shift+Enter step through matches, Escape closes it and leaves the current
 * match selected for editing.
 */
function FindBar({
  query,
  setQuery,
  matches,
  current,
  setCurrent,
  focus,
  onClose,
}: {
  query: string;
  setQuery: (q: string) => void;
  matches: Match[];
  current: number;
  setCurrent: (i: number) => void;
  focus: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focus]);

  function step(delta: number) {
    if (matches.length === 0) return;
    setCurrent((current + delta + matches.length) % matches.length);
  }

  return (
    <div
      role="search"
      className="raised absolute top-3 right-4 z-20 flex h-10 items-center overflow-hidden rounded-lg pr-1 pl-3 transition-colors duration-100 animate-in fade-in-0 slide-in-from-top-1 focus-within:border-teal!"
    >
      <Search size={15} className="mr-2.5 shrink-0 text-ink-3" aria-hidden />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        className="field-plain w-56 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4"
      />
      {/* Tells you the query found nothing without reading the words. */}
      <span
        className={cn(
          "ml-2 min-w-16 text-right text-xs tabular-nums",
          query !== "" && matches.length === 0 ? "text-amber-ink" : "text-ink-3",
        )}
        aria-live="polite"
      >
        {query === ""
          ? ""
          : matches.length === 0
            ? t("find.none")
            : t("find.count", { current: current + 1, total: matches.length })}
      </span>
      <span className="mx-2 h-5 w-px bg-line" aria-hidden />
      <FindButton label={t("find.previous")} disabled={matches.length === 0} onClick={() => step(-1)}>
        <ChevronUp size={16} />
      </FindButton>
      <FindButton label={t("find.next")} disabled={matches.length === 0} onClick={() => step(1)}>
        <ChevronDown size={16} />
      </FindButton>
      <FindButton label={t("find.close")} onClick={onClose}>
        <X size={16} />
      </FindButton>
    </div>
  );
}

function FindButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      // Keeps focus in the field, so typing carries on after a click.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors hover:bg-ink/[0.07] hover:text-ink disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-3"
    >
      {children}
    </button>
  );
}
