import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Minus, Square, X } from "lucide-react";
import { requestZoom as zoom, useAppCommands } from "@/lib/app-commands";
import { formatShortcut, MOD, SHIFT_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizeBorders } from "./resize-borders";

/** Window commands are all no-ops outside the desktop shell (`bun run dev`). */
function win(fn: "minimize" | "toggleMaximize" | "close") {
  if (isTauri()) getCurrentWindow()[fn]().catch(console.error);
}

/**
 * The window's own frame, drawn by us: `decorations: false` in
 * tauri.conf.json means nothing else provides one.
 *
 * `data-tauri-drag-region` turns the bar into the window's drag handle. It must
 * stay off every interactive child, or pressing a menu or a window button
 * starts dragging the window instead of clicking. Each window command it issues
 * also needs its own permission in `capabilities/default.json` — the default
 * set can only *read* window state, so a missing one fails silently at runtime.
 *
 * The compositor's resize border goes with the decorations, so `ResizeBorders`
 * puts its own grips back around the whole window.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const w = getCurrentWindow();
    const sync = () => {
      w.isMaximized().then(setMaximized).catch(console.error);
      w.isFullscreen().then(setFullscreen).catch(console.error);
    };
    sync();
    const unlisten = w.onResized(sync);
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!isTauri()) return;
    const next = !fullscreen;
    getCurrentWindow()
      .setFullscreen(next)
      .then(() => setFullscreen(next), console.error);
  }, [fullscreen]);

  // The menu advertises these, so they have to actually work.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "q" || e.key === "Q")) {
        e.preventDefault();
        win("close");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);

  return (
    <>
      <ResizeBorders disabled={maximized || fullscreen} />
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface-2 pr-1 pl-1.5 select-none"
      >
        <AppMenus
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
        />
        <WindowControls maximized={maximized} />
      </div>
    </>
  );
}

type MenuKey = "file" | "edit" | "view";

function AppMenus({
  fullscreen,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { t } = useTranslation();
  const c = useAppCommands();
  const edit = useEditActions();
  // Which menu is open, so that sliding the pointer across the strip switches
  // menus the way a desktop menu bar does. Plain dropdowns don't do this on
  // their own — the open one has to be told to hand over.
  const [open, setOpen] = useState<MenuKey | null>(null);
  const openOnHover = (key: MenuKey) => () => {
    if (open !== null && open !== key) setOpen(key);
  };

  return (
    <div className="flex items-center">
      <Menu
        label={t("menu.file")}
        menuKey="file"
        open={open}
        setOpen={setOpen}
        onHover={openOnHover}
      >
        <Item label={t("menu.backToLibrary")} disabled={!c.back} onSelect={c.back} />
        <Item
          label={t("menu.importPdf")}
          disabled={!c.importPdf}
          onSelect={c.importPdf}
        />
        <Item label={t("menu.exportAudiobook")} disabled onSelect={c.exportAudiobook} />
        <Sep />
        <Item
          label={t("menu.quit")}
          shortcut={formatShortcut(MOD, "Q")}
          onSelect={() => win("close")}
        />
      </Menu>

      {/* Nothing in this menu means anything without a text field to act on,
          so the whole strip item goes dead on the library screen. */}
      <Menu
        label={t("menu.edit")}
        menuKey="edit"
        open={open}
        setOpen={setOpen}
        onHover={openOnHover}
        disabled={!c.canEdit}
      >
        <Item
          label={t("menu.undo")}
          shortcut={formatShortcut(MOD, "Z")}
          onSelect={() => edit("undo")}
        />
        <Item
          label={t("menu.redo")}
          shortcut={formatShortcut(MOD, SHIFT_KEY, "Z")}
          onSelect={() => edit("redo")}
        />
        <Sep />
        <Item
          label={t("menu.savePage")}
          shortcut={formatShortcut(MOD, "S")}
          disabled={!c.savePage}
          onSelect={c.savePage}
        />
        <Item
          label={t("menu.markPageDone")}
          checked={!!c.pageDone}
          disabled={!c.togglePageDone}
          onSelect={c.togglePageDone}
        />
        <Sep />
        <Item
          label={t("menu.cut")}
          shortcut={formatShortcut(MOD, "X")}
          onSelect={() => edit("cut")}
        />
        <Item
          label={t("menu.copy")}
          shortcut={formatShortcut(MOD, "C")}
          onSelect={() => edit("copy")}
        />
        <Item
          label={t("menu.paste")}
          shortcut={formatShortcut(MOD, "V")}
          onSelect={() => edit("paste")}
        />
      </Menu>

      <Menu
        label={t("menu.view")}
        menuKey="view"
        open={open}
        setOpen={setOpen}
        onHover={openOnHover}
      >
        {VIEWS.map(({ key, labelKey }) => (
          <Item
            key={key}
            label={t(labelKey)}
            checked={c.view === key}
            disabled={!c.setView}
            onSelect={() => c.setView?.(key)}
          />
        ))}
        <Sep />
        <Item
          label={t("menu.togglePageList")}
          shortcut={formatShortcut(MOD, "\\")}
          disabled={!c.toggleLeftPanel}
          onSelect={c.toggleLeftPanel}
        />
        <Item
          label={t("menu.toggleSettingsPanel")}
          shortcut={formatShortcut(MOD, SHIFT_KEY, "\\")}
          disabled={!c.toggleRightPanel}
          onSelect={c.toggleRightPanel}
        />
        <Sep />
        <Item
          label={t("menu.zoomIn")}
          shortcut={formatShortcut(MOD, "+")}
          disabled={!c.canZoom}
          onSelect={() => zoom("in")}
        />
        <Item
          label={t("menu.zoomOut")}
          shortcut={formatShortcut(MOD, "-")}
          disabled={!c.canZoom}
          onSelect={() => zoom("out")}
        />
        <Item
          label={t("menu.resetZoom")}
          shortcut={formatShortcut(MOD, "0")}
          disabled={!c.canZoom}
          onSelect={() => zoom("reset")}
        />
        <Sep />
        <Item
          label={t("menu.fullscreen")}
          shortcut="F11"
          checked={fullscreen}
          onSelect={onToggleFullscreen}
        />
      </Menu>
    </div>
  );
}

/** Labels are catalogue keys, resolved at render: a module constant is
    evaluated once, and would freeze whichever language was active then. */
const VIEWS: { key: "pdf" | "split" | "edit"; labelKey: string }[] = [
  { key: "pdf", labelKey: "viewMode.pdfPreview" },
  { key: "split", labelKey: "viewMode.sideBySide" },
  { key: "edit", labelKey: "viewMode.extractedText" },
];

function Menu({
  label,
  menuKey,
  open,
  setOpen,
  onHover,
  disabled,
  children,
}: {
  label: string;
  menuKey: MenuKey;
  open: MenuKey | null;
  setOpen: (k: MenuKey | null) => void;
  onHover: (k: MenuKey) => () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    // Not modal: a modal dropdown blocks pointer events outside itself, which
    // would swallow the hover that moves to the next menu.
    <DropdownMenu
      modal={false}
      open={open === menuKey}
      onOpenChange={(o) => setOpen(o ? menuKey : null)}
    >
      <DropdownMenuTrigger
        disabled={disabled}
        onPointerEnter={onHover(menuKey)}
        className={cn(
          "cursor-pointer rounded-md px-2 py-1 text-[13px] font-medium text-ink-2 outline-none! transition-colors",
          "hover:bg-paper-3 hover:text-ink data-[state=open]:bg-paper-3 data-[state=open]:text-ink",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-56 border-line-2 bg-menu shadow-paper-lg"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A group divider. One shade stronger than the default: menus sit on `--menu`,
 * which in the dark palette is the same value as `--line`, so the stock
 * separator disappears into the panel it's meant to divide.
 */
function Sep() {
  return <DropdownMenuSeparator className="bg-line-2" />;
}

/**
 * One menu row. Deliberately built from plain items only: shadcn's checkbox
 * item reserves a left gutter for its tick, which would indent half the menu
 * and leave the rest ragged. State is shown on the right instead.
 */
function Item({
  label,
  shortcut,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={() => onSelect?.()}>
      {label}
      {/* One right-hand slot, so a row with both a tick and a shortcut keeps
          them together instead of pushing one to the middle. */}
      <span className="ml-auto flex items-center gap-2">
        {checked && <Check className="text-teal-ink" strokeWidth={2.4} />}
        {shortcut && (
          <DropdownMenuShortcut className="ml-0">
            {shortcut}
          </DropdownMenuShortcut>
        )}
      </span>
    </DropdownMenuItem>
  );
}

type EditAction = "undo" | "redo" | "cut" | "copy" | "paste";

/**
 * Run an edit action against the field the user was last typing in.
 *
 * Opening a menu moves focus, and these commands only mean anything with the
 * text field focused and its selection intact — so the field is remembered on
 * the way past and refocused here. `execCommand` is what keeps the textarea's
 * own undo stack in play; nothing else can push onto it.
 */
function useEditActions() {
  const lastRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
        lastRef.current = t;
      }
    }
    window.addEventListener("focusin", onFocusIn);
    return () => window.removeEventListener("focusin", onFocusIn);
  }, []);

  return useCallback((action: EditAction) => {
    const el = lastRef.current;
    if (!el || !el.isConnected) return;
    el.focus();
    if (action === "paste") {
      // execCommand("paste") is refused by the webview for security, so read
      // the clipboard ourselves and insert the text as if it were typed —
      // insertText is undoable, direct value assignment is not.
      navigator.clipboard
        .readText()
        .then((t) => t && document.execCommand("insertText", false, t))
        .catch(console.error);
      return;
    }
    document.execCommand(action);
  }, []);
}

function WindowControls({ maximized }: { maximized: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-0.5">
      <ControlButton label={t("window.minimise")} onClick={() => win("minimize")}>
        <Minus size={16} strokeWidth={2.6} />
      </ControlButton>
      <ControlButton
        label={t(maximized ? "window.restore" : "window.maximise")}
        onClick={() => win("toggleMaximize")}
      >
        <Square size={12.5} strokeWidth={2.8} />
      </ControlButton>
      <ControlButton label={t("window.close")} onClick={() => win("close")}>
        <X size={16} strokeWidth={2.6} />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-7 cursor-pointer place-items-center rounded-md text-ink-2 transition-colors",
        "hover:bg-paper-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
