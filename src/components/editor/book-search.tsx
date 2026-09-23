import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { listPageTexts } from "@/lib/api";
import { searchPages, type Snippet } from "@/lib/text-search";

/** Waits this long after the last keystroke before searching. */
const SEARCH_DEBOUNCE_MS = 120;
/** Past this many matches only the first are listed; the count stays true. */
const MAX_LISTED = 300;

export type BookSearchPick = { pageNo: number; start: number; end: number; query: string };

/**
 * The book-wide search palette (Ctrl+Shift+F): floats over the editor, lists
 * every match grouped by page, and closes on a pick.
 *
 * The book's text is read once when the palette opens, and the page being
 * edited is taken from the editor instead, so an edit still waiting out its
 * autosave is searched as it appears on screen.
 */
export function BookSearch({
  projectId,
  activePage,
  activeText,
  onPick,
  onClose,
}: {
  projectId: string;
  activePage: number;
  activeText: string;
  onPick: (pick: BookSearchPick) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<{ pageNo: number; text: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPageTexts(projectId).then(
      (p) => !cancelled && setPages(p),
      (e: unknown) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const results = useMemo(() => {
    if (!pages) return [];
    const live = pages.map((p) => (p.pageNo === activePage ? { ...p, text: activeText } : p));
    return searchPages(live, debounced);
  }, [pages, activePage, activeText, debounced]);

  const flat = useMemo(() => {
    const out: { pageNo: number; snippet: Snippet }[] = [];
    for (const r of results) for (const s of r.snippets) out.push({ pageNo: r.pageNo, snippet: s });
    return out;
  }, [results]);
  const listed = flat.slice(0, MAX_LISTED);

  useEffect(() => setSelected(0), [debounced]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function pick(i: number) {
    const hit = listed[i];
    if (!hit) return;
    onPick({ pageNo: hit.pageNo, start: hit.snippet.start, end: hit.snippet.end, query: debounced });
  }

  // Per-page match counts, for the group headings.
  const perPage = useMemo(
    () => new Map(results.map((r) => [r.pageNo, r.snippets.length])),
    [results],
  );
  const searching = debounced.trim() !== "";

  let lastPage = -1;
  return (
    // Clicking outside the palette closes it.
    <div
      className="fixed inset-0 z-50 bg-scrim duration-100 animate-in fade-in-0 supports-backdrop-filter:backdrop-blur-xs"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-label={t("search.placeholder")}
        onMouseDown={(e) => e.stopPropagation()}
        // A fixed height, centred: the palette must not jump around the
        // screen as results arrive and the list grows or empties.
        className="fixed top-1/2 left-1/2 flex h-[min(36rem,78vh)] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl text-ink duration-100 raised animate-in fade-in-0 zoom-in-95"
      >
        <div className="flex h-15 shrink-0 items-center gap-3 border-b border-line-2 px-5">
          <Search size={18} className="shrink-0 text-ink-3" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => Math.min(listed.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(selected);
              }
            }}
            placeholder={t("search.placeholder")}
            className="field-plain min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-4"
          />
          {searching && pages && flat.length > 0 && (
            <span className="shrink-0 text-[13px] text-ink-3 tabular-nums">
              {t("search.summary", { count: flat.length, pages: results.length })}
            </span>
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5 scroll-inset">
          {error !== null ? (
            <Notice tone="warn">{t("search.error", { error })}</Notice>
          ) : pages === null ? (
            <Notice>{t("search.loading")}</Notice>
          ) : !searching ? (
            <Notice>{t("search.hint")}</Notice>
          ) : flat.length === 0 ? (
            <Notice>{t("search.none")}</Notice>
          ) : (
            listed.map((hit, i) => {
              const header = hit.pageNo !== lastPage;
              lastPage = hit.pageNo;
              return (
                <div key={i}>
                  {header && (
                    <div className="sticky top-0 z-10 flex items-baseline justify-between bg-surface px-3 pt-4 pb-1.5 text-[13px]">
                      <span className="font-medium text-ink-2">
                        {t("search.page", { n: hit.pageNo })}
                      </span>
                      <span className="text-ink-4 tabular-nums">{perPage.get(hit.pageNo)}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    data-index={i}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => pick(i)}
                    className={cn(
                      "block w-full cursor-pointer truncate rounded-lg px-3 py-2.5 text-left text-sm leading-snug text-ink-2 transition-colors",
                      i === selected && "bg-ink/[0.07] text-ink",
                    )}
                  >
                    {hit.snippet.before}
                    <mark className="rounded-[3px] bg-teal-soft px-0.5 font-medium text-teal-ink">
                      {hit.snippet.match}
                    </mark>
                    {hit.snippet.after}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** A one-line state message, centred in the empty list. */
function Notice({ tone, children }: { tone?: "warn"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid h-full place-items-center px-8 text-center text-sm",
        tone === "warn" ? "text-amber-ink" : "text-ink-3",
      )}
    >
      {children}
    </div>
  );
}
