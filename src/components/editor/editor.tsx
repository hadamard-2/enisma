import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  PanelLeft,
  PanelRight,
  Pencil,
} from "lucide-react";
import {
  useDefaultLayout,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import {
  getPage,
  getProject,
  savePageText,
  setPageDone,
  updateProject,
  type PageMeta,
  type ProjectDetail,
} from "@/lib/api";
import { PLACEHOLDER_VOICES } from "@/lib/placeholder-voices";
import { cn } from "@/lib/utils";
import { formatShortcut, MOD, SHIFT_KEY } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { PagePanel, type PageFilter } from "./page-panel";
import { CenterPanel, type View } from "./center-panel";
import { SettingsPanel } from "./settings-panel";

const VIEW_ORDER: View[] = ["pdf", "split", "edit"];

export function EditorRoute() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) return;
    getProject(id).then(setProject).catch(() => setMissing(true));
  }, [id]);

  if (missing) return <Navigate to="/" replace />;
  if (!project) return <div className="flex-1 bg-paper" />;

  return <Editor project={project} onBack={() => navigate("/")} />;
}

function Editor({
  project,
  onBack,
}: {
  project: ProjectDetail;
  onBack: () => void;
}) {
  const [pages, setPages] = useState<PageMeta[]>(project.pages);
  const [activePage, setActivePage] = useState(
    project.pages.find((p) => !p.done)?.pageNo ?? 1,
  );
  const [language, setLanguage] = useState<string>(project.language);
  const initialVoice = (PLACEHOLDER_VOICES[project.language] ?? [])[0] ?? "";
  const [voice, setVoice] = useState(initialVoice);
  const [speed, setSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(0.0);
  const [playing, setPlaying] = useState(false);
  const [filter, setFilter] = useState<PageFilter>("all");
  const [text, setText] = useState("");
  const savedTextRef = useRef("");
  // Which page `text`/`savedTextRef` currently represent. Updated by the
  // autosave effect below the moment it has actually processed a given
  // `activePage`, which is what lets it tell "the user typed" apart from
  // "the page changed" on the very next render (see that effect's comment).
  const lastPageRef = useRef(activePage);
  const [saved, setSaved] = useState(true);
  const [view, setView] = useState<View>("split");

  // Load the active page's text. Guards against out-of-order responses: if
  // the page changes again before this fetch resolves, `cancelled` (captured
  // per effect run) is already true by the time it does, so a late response
  // for a page we've since left can never overwrite `text` out from under
  // whatever page is now active.
  useEffect(() => {
    let cancelled = false;
    getPage(project.id, activePage).then((p) => {
      if (cancelled) return;
      const value = p.editedText ?? p.sourceText ?? "";
      savedTextRef.current = value;
      setText(value);
      setSaved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, activePage]);

  // Autosave on a short debounce; this is what finally makes the panel's
  // "saved / unsaved changes" indicator tell the truth.
  //
  // This effect also re-runs the instant `activePage` changes — before the
  // loader effect above has fetched the new page's text. At that moment
  // `text` still holds the OUTGOING page's content while `activePage`
  // already points at the new one; scheduling
  // `savePageText(project.id, activePage, text)` in that state would write
  // the old page's edit into the new page's row (or, if the load wins the
  // race and text/savedTextRef sync up first, cancel the pending timer and
  // discard the edit with nothing ever written). `lastPageRef` records which
  // page this effect last actually processed, so a mismatch against
  // `activePage` means "the page changed, not the text" — in which case we
  // flush the edit immediately under the page it actually belongs to
  // (`pageForThisText`) instead of scheduling anything under the new page.
  useEffect(() => {
    const pageForThisText = lastPageRef.current;
    lastPageRef.current = activePage;

    if (pageForThisText !== activePage) {
      if (text !== savedTextRef.current) {
        savePageText(project.id, pageForThisText, text).catch(console.error);
      }
      return;
    }

    if (text === savedTextRef.current) {
      setSaved(true);
      return;
    }
    setSaved(false);
    const t = setTimeout(() => {
      savePageText(project.id, activePage, text)
        .then(() => {
          savedTextRef.current = text;
          setSaved(true);
        })
        .catch(console.error);
    }, 500);
    return () => clearTimeout(t);
  }, [text, project.id, activePage]);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(false), 4500);
    return () => clearTimeout(t);
  }, [playing]);

  const counts = useMemo(
    () => ({
      doneCount: pages.filter((p) => p.done).length,
      notDoneCount: pages.filter((p) => !p.done).length,
    }),
    [pages],
  );

  const visiblePages = useMemo(() => {
    if (filter === "all") return pages;
    if (filter === "done") return pages.filter((p) => p.done);
    return pages.filter((p) => !p.done);
  }, [pages, filter]);

  function toggleDone(n: number) {
    const next = !(pages.find((p) => p.pageNo === n)?.done ?? false);
    setPages((ps) => ps.map((p) => (p.pageNo === n ? { ...p, done: next } : p)));
    setPageDone(project.id, n, next).catch((e) => {
      console.error(e);
      // Write failed — revert the optimistic flip so the panel and counts
      // don't keep showing a state that was never actually persisted.
      setPages((ps) => ps.map((p) => (p.pageNo === n ? { ...p, done: !next } : p)));
    });
  }

  function gotoPage(delta: number) {
    const idx = visiblePages.findIndex((p) => p.pageNo === activePage);
    if (idx === -1) return;
    const nextIdx = Math.max(0, Math.min(visiblePages.length - 1, idx + delta));
    const next = visiblePages[nextIdx];
    if (next) setActivePage(next.pageNo);
  }

  function cycleView(delta: number) {
    const idx = VIEW_ORDER.indexOf(view);
    const nextIdx = (idx + delta + VIEW_ORDER.length) % VIEW_ORDER.length;
    setView(VIEW_ORDER[nextIdx]!);
  }

  const activeDone = pages.find((p) => p.pageNo === activePage)?.done ?? false;

  const leftPanelRef = useRef<PanelImperativeHandle | null>(null);
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const layout = useDefaultLayout({
    id: "hb-editor-panels-v4",
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  });

  const [pillVisible, setPillVisible] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const showPill = () => {
    setPillVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setPillVisible(false), 1800);
  };
  useEffect(
    () => () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const toggleLeft = () => {
    const p = leftPanelRef.current;
    if (!p) return;
    p.isCollapsed() ? p.expand() : p.collapse();
  };
  const toggleRight = () => {
    const p = rightPanelRef.current;
    if (!p) return;
    p.isCollapsed() ? p.expand() : p.collapse();
  };

  useEffect(() => {
    function isTypingTarget(t: EventTarget | null) {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "\\") {
        e.preventDefault();
        if (e.shiftKey) toggleRight();
        else toggleLeft();
        return;
      }
      if (mod && e.key === "ArrowLeft") {
        e.preventDefault();
        cycleView(-1);
        return;
      }
      if (mod && e.key === "ArrowRight") {
        e.preventDefault();
        cycleView(1);
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        gotoPage(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        gotoPage(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3 py-2.5">
        <Button
          variant="ghost"
          size="icon-lg"
          onClick={onBack}
          aria-label="Back to library"
          title="Back to library"
          className="-ml-0.5 text-ink-2"
        >
          <ChevronLeft className="size-5" />
        </Button>

        <input
          defaultValue={project.title}
          onBlur={(e) => updateProject(project.id, { title: e.target.value }).catch(console.error)}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-0.5 font-serif text-[15px] font-medium text-ink outline-none focus:border-line"
        />

        <Button size="default" onClick={() => console.log("Export audiobook (stub)")}>
          <Download />
          Export
        </Button>
      </header>

      <div
        className="relative flex min-h-0 flex-1"
        onMouseMove={showPill}
      >
        <FloatingPanelToggle
          side="left"
          collapsed={leftCollapsed}
          onClick={toggleLeft}
        />
        <FloatingViewToggle view={view} setView={setView} />
        <FloatingPanelToggle
          side="right"
          collapsed={rightCollapsed}
          onClick={toggleRight}
        />

        <FloatingPagePill
          page={activePage}
          totalPages={pages.length}
          visible={pillVisible}
          onPrev={() => gotoPage(-1)}
          onNext={() => gotoPage(1)}
        />

        <ResizablePanelGroup
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
          className="min-h-0 flex-1"
        >
          <ResizablePanel
            id="left"
            panelRef={leftPanelRef}
            defaultSize="22%"
            minSize="18%"
            maxSize="30%"
            collapsible
            collapsedSize={0}
            onResize={(s) => setLeftCollapsed(s.asPercentage === 0)}
          >
            <PagePanel
              pages={pages}
              filter={filter}
              setFilter={setFilter}
              active={activePage}
              setActive={setActivePage}
              counts={counts}
            />
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel id="center" defaultSize="52%" minSize="35%">
            <CenterPanel
              page={activePage}
              pdfPath={project.pdfPath}
              text={text}
              setText={setText}
              saved={saved}
              view={view}
            />
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel
            id="right"
            panelRef={rightPanelRef}
            defaultSize="30%"
            minSize="24%"
            maxSize="38%"
            collapsible
            collapsedSize={0}
            onResize={(s) => setRightCollapsed(s.asPercentage === 0)}
          >
            <SettingsPanel
              language={language}
              setLanguage={(l) => {
                setLanguage(l);
                updateProject(project.id, { language: l }).catch(console.error);
              }}
              voice={voice}
              setVoice={setVoice}
              speed={speed}
              setSpeed={setSpeed}
              pitch={pitch}
              setPitch={setPitch}
              playing={playing}
              setPlaying={setPlaying}
              page={activePage}
              done={activeDone}
              onToggleDone={() => toggleDone(activePage)}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function FloatingPanelToggle({
  side,
  collapsed,
  onClick,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  const label = `${collapsed ? "Show" : "Hide"} ${side} panel`;
  const shortcut =
    side === "left"
      ? formatShortcut(MOD, "\\")
      : formatShortcut(MOD, SHIFT_KEY, "\\");
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={`${label} (${shortcut})`}
      className={cn(
        "absolute top-3 z-20 grid size-8 cursor-pointer place-items-center rounded-md transition-all hover:text-ink",
        side === "left" ? "left-3" : "right-3",
        collapsed
          ? "border border-line bg-surface text-ink-2 shadow-paper-sm hover:bg-paper-2"
          : "border border-transparent text-ink-3 opacity-50 hover:bg-paper-3 hover:opacity-100",
      )}
    >
      <Icon size={16} strokeWidth={1.7} />
    </button>
  );
}

const VIEW_ITEMS: { key: View; label: string; Icon: typeof FileText }[] = [
  { key: "pdf", label: "PDF preview", Icon: FileText },
  { key: "split", label: "Side by side", Icon: BookOpen },
  { key: "edit", label: "Extracted text", Icon: Pencil },
];

function FloatingViewToggle({
  view,
  setView,
}: {
  view: View;
  setView: (v: View) => void;
}) {
  return (
    <div className="absolute top-3 right-13 z-20 flex gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-paper-sm">
      {VIEW_ITEMS.map(({ key, label, Icon }) => {
        const active = view === key;
        return (
          <button
            key={key}
            onClick={() => setView(key)}
            aria-label={label}
            title={label}
            className={cn(
              "grid size-7 cursor-pointer place-items-center rounded-sm transition-colors",
              active
                ? "bg-teal-soft text-teal-ink"
                : "text-ink-3 hover:bg-paper-2 hover:text-ink",
            )}
          >
            <Icon size={15} strokeWidth={1.7} />
          </button>
        );
      })}
    </div>
  );
}

function FloatingPagePill({
  page,
  totalPages,
  visible,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  visible: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div
      className={cn(
        "absolute bottom-8 left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-paper-md transition-opacity duration-200",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <button
        onClick={onPrev}
        aria-label="Previous page (↑)"
        title="Previous page (↑)"
        className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink"
      >
        <ChevronLeft size={16} strokeWidth={1.8} />
      </button>

      <span className="px-2 font-mono text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">{page}</span>
        <span className="text-ink-3"> / {totalPages}</span>
      </span>

      <button
        onClick={onNext}
        aria-label="Next page (↓)"
        title="Next page (↓)"
        className="grid size-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink"
      >
        <ChevronRight size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}
