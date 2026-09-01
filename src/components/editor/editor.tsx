import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const SAVE_DEBOUNCE_MS = 500;

/**
 * One queued page-text write. The project and page travel WITH the text, so a
 * write dispatched later — after the user has already paged away — still lands
 * on the row the text was actually typed into.
 */
type PendingWrite = {
  projectId: string;
  page: number;
  text: string;
  /** Already handed to the write chain; kept so an identical re-queue is a no-op. */
  sent: boolean;
  /**
   * The text the page should end up holding once this write settles.
   *
   * Set only when an edit is reverted to the stored baseline after its write
   * was already dispatched — too late to cancel. The write will land, so the
   * revert has to be re-queued behind it or storage keeps the undone text
   * while the screen shows it gone.
   */
  supersededBy?: string;
};

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

  // Keyed on the project so switching projects remounts rather than reusing
  // the autosave state machine. Its in-flight guards compare page numbers, so
  // a same-numbered page in a different project could otherwise be adopted as
  // the baseline for text that came from the previous one.
  return <Editor key={project.id} project={project} onBack={() => navigate("/")} />;
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
  // Which page `text`/`savedTextRef` truthfully represent right now, or null
  // while no load has resolved yet. Only the loader's `.then()` below may
  // advance this ref — a fetch landing is the one event that actually
  // establishes "the text in state came from page N". Everything else reads it.
  const textPageRef = useRef<number | null>(null);
  const [saved, setSaved] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("split");

  // ---- Autosave machinery -------------------------------------------------
  // The debounce deliberately does NOT live inside an effect. An effect's
  // cleanup runs on every `text`/`activePage` change, so a timer owned by one
  // is torn down by the very page switch it has to survive — which is what
  // forced earlier versions of this code to choose between cancelling a real
  // pending write and firing an un-debounced one. These refs outlive every
  // dependency change: a pending write is cancelled only by being superseded,
  // and is flushed explicitly when we leave the page.
  const pendingRef = useRef<PendingWrite | null>(null);
  // The write currently on the chain, if any. Separate from `pendingRef`
  // because the two diverge: once a write is dispatched the user can type
  // again, and the slot then holds the NEW edit while the old one is still
  // travelling. A revert has to be able to find the travelling write to
  // correct it, whichever of the two the slot happens to be holding.
  const inFlightRef = useRef<PendingWrite | null>(null);
  const debounceRef = useRef<number | null>(null);
  // Every write is appended to this one chain, so `savePageText` calls are
  // invoked strictly in dispatch order and a slower earlier write can never
  // land on top of a newer one.
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const sendPending = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const p = pendingRef.current;
    if (!p || p.sent) return;
    p.sent = true;
    inFlightRef.current = p;

    // Runs however this write settles. A write that was superseded while in
    // flight has to be followed by the correction, or the revert is lost:
    // the screen would show the reverted text while storage keeps what was
    // written, and nothing on the way out of the page would notice.
    const settle = () => {
      if (inFlightRef.current === p) inFlightRef.current = null;
      if (pendingRef.current === p) pendingRef.current = null;
      if (p.supersededBy === undefined) return;
      // Something newer already owns the queue. It was typed after the revert,
      // so it — not this correction — is where the page should end up. (If it
      // belongs to another page the correction is dropped rather than
      // clobbering it; conservative, and it heals on the next edit here.)
      if (pendingRef.current !== null) return;
      pendingRef.current = {
        projectId: p.projectId,
        page: p.page,
        text: p.supersededBy,
        sent: false,
      };
      setSaved(false);
      // Bounded: the follow-up carries no `supersededBy` of its own unless the
      // user reverts again, which is a fresh edit, not a recursion.
      sendPending();
    };

    writeChainRef.current = writeChainRef.current
      .catch(() => {})
      .then(() => savePageText(p.projectId, p.page, p.text))
      .then(
        () => {
          // Only adopt this as the saved baseline if `text` still belongs to
          // the page we just wrote; otherwise we would be comparing the page
          // now on screen against some other page's content.
          if (textPageRef.current === p.page) {
            savedTextRef.current = p.text;
            setSaved(pendingRef.current === null || pendingRef.current === p);
          }
          settle();
        },
        (e: unknown) => {
          console.error(e);
          // Release the slot so a later effect run can queue the same text
          // again; the indicator stays on "unsaved changes" until one lands.
          settle();
        },
      );
  }, []);

  const queueEdit = useCallback(
    (projectId: string, page: number, value: string) => {
      // A fresh edit on this page redefines where the page ends up, so a
      // revert recorded against a write still in flight no longer applies —
      // including when that edit re-types exactly what the in-flight write
      // already carries and is handled by the no-op below.
      const f = inFlightRef.current;
      if (f && f.page === page && f.projectId === projectId) delete f.supersededBy;

      const p = pendingRef.current;
      if (p && p.projectId === projectId && p.page === page && p.text === value) {
        // Already queued, or already in flight. An effect re-run for an
        // unrelated reason must not restart the debounce or double-write.
        return;
      }
      // Defensive: never let a still-unsent edit for another page be silently
      // overwritten in the single pending slot. (The page-change flush below
      // should already have sent it.)
      if (p && !p.sent && (p.page !== page || p.projectId !== projectId)) {
        sendPending();
      }
      pendingRef.current = { projectId, page, text: value, sent: false };
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        sendPending();
      }, SAVE_DEBOUNCE_MS);
    },
    [sendPending],
  );

  // Load the active page's text.
  //
  // The read goes on the SAME chain as the writes, so it cannot start before
  // this page's already-queued writes have settled. Without that ordering a
  // fast 5 -> 6 -> 5 lets the page-5 read overtake the page-5 write still in
  // flight: the read returns pre-edit text, `savedTextRef` and `text` both
  // adopt it, and the next keystroke sends that stale textarea back over the
  // edit. The added wait only ever follows a write that was already debounced.
  //
  // `cancelled` (captured per effect run) still guards against a response for
  // a page we have since left overwriting whatever page is now active.
  useEffect(() => {
    let cancelled = false;
    const load = writeChainRef.current
      .catch(() => {})
      .then(() => (cancelled ? null : getPage(project.id, activePage)));
    // Put the read back on the chain so a write queued behind it also waits,
    // keeping reads and writes in one total order. Swallowing the rejection
    // here keeps the chain usable; the handler below reports it.
    writeChainRef.current = load.catch(() => {});
    load.then(
      (p) => {
        if (cancelled || p === null) return;
        const value = p.editedText ?? p.sourceText ?? "";
        savedTextRef.current = value;
        textPageRef.current = activePage;
        setText(value);
        setSaved(true);
        setLoadError(null);
      },
      (e: unknown) => {
        if (cancelled) return;
        console.error(e);
        // Nothing now describes this page, so nothing may claim to. Leaving
        // the previous page's text in place would show it beside the new
        // page's scan, labelled "saved", and file the next keystroke under
        // the page it came from.
        textPageRef.current = null;
        savedTextRef.current = "";
        setText("");
        setSaved(true);
        setLoadError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project.id, activePage]);

  // Leaving a page (or the editor) sends whatever is still queued, addressed
  // to the page it was typed on. This is what stops the single pending slot
  // from ever being reused for a different page while an edit is still waiting
  // out its debounce — and it is the only place a page change touches the
  // pending write, which is why the timer no longer has to die with the effect.
  useEffect(() => () => sendPending(), [project.id, activePage, sendPending]);

  // Autosave on a short debounce; this is what finally makes the panel's
  // "saved / unsaved changes" indicator tell the truth.
  //
  // This effect only decides WHAT to queue — never when the write goes out. It
  // attributes `text` to `textPageRef`, the page a load actually delivered it
  // for, and never to `activePage`, which runs ahead of the text during the gap
  // between a page switch and that page's fetch resolving.
  useEffect(() => {
    const page = textPageRef.current;

    if (text === savedTextRef.current) {
      // The edit was reverted back to the stored baseline (backspace, undo)
      // before its debounce fired, so the queued write is now superseded by
      // nothing and must not go out. Scoped deliberately: only a pending that
      // is still UNSENT and belongs to the page `text` itself belongs to is
      // discarded. A pending for a page we have already left is a real edit
      // waiting out its timer, and has to survive this branch.
      const p = pendingRef.current;
      if (p && !p.sent && p.page === page && p.projectId === project.id) {
        pendingRef.current = null;
        if (debounceRef.current !== null) {
          window.clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
      }

      // A write already on the chain cannot be cancelled — it will land, and
      // it carries the text the user has just undone. Record where the page
      // must end up so the completion re-queues it. Until that correction
      // lands, storage and the screen disagree, so the indicator must not
      // claim "saved".
      const f = inFlightRef.current;
      if (f && f.page === page && f.projectId === project.id) {
        f.supersededBy = text;
        setSaved(false);
        return;
      }

      setSaved(true);
      return;
    }
    setSaved(false);

    // No load has resolved yet, so nothing has established which page this
    // text belongs to. Don't invent an owner for it.
    if (page === null) return;

    queueEdit(project.id, page, text);
  }, [text, project.id, activePage, queueEdit]);

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
      // Before the typing guard on purpose: the footer advertises this, and
      // the user is in the textarea when they reach for it. Without the
      // preventDefault the browser's own save dialog opens instead.
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        sendPending();
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
              loadError={loadError}
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
