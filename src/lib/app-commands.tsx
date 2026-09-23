import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * What the title bar's menus can act on right now.
 *
 * The menu strip lives above the router, but almost everything it offers
 * belongs to whatever screen is mounted below it. Rather than lifting the
 * editor's state up into the app shell, each screen registers the commands it
 * can service; anything absent renders disabled. A screen that doesn't know
 * about a command simply doesn't register it.
 */
/**
 * Zoom is the one command the menu can't call directly: the level lives inside
 * the PDF viewer, which mounts and unmounts with the view mode. An event keeps
 * the level where it belongs instead of lifting it into the app shell.
 */
export type ZoomCommand = "in" | "out" | "reset";
export const ZOOM_EVENT = "enisma:zoom";

export function requestZoom(kind: ZoomCommand) {
  window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: kind }));
}

export type AppCommands = {
  /** Leave the editor for the library. */
  back?: () => void;
  importPdf?: () => void;
  exportAudiobook?: () => void;
  /** There's a text field on this screen, so the Edit menu has something to act on. */
  canEdit?: boolean;
  savePage?: () => void;
  /** Open the find bar on the current page. */
  find?: () => void;
  /** Open the book-wide search. */
  findInBook?: () => void;
  togglePageDone?: () => void;
  /** Whether the active page is done — drives the menu item's checkmark. */
  pageDone?: boolean;
  view?: "pdf" | "split" | "edit";
  setView?: (v: "pdf" | "split" | "edit") => void;
  toggleLeftPanel?: () => void;
  toggleRightPanel?: () => void;
  /** True while a PDF is on screen and can take the zoom commands. */
  canZoom?: boolean;
};

type Ctx = {
  commands: AppCommands;
  register: (c: AppCommands) => () => void;
};

const AppCommandsContext = createContext<Ctx | null>(null);

export function AppCommandsProvider({ children }: { children: React.ReactNode }) {
  const [commands, setCommands] = useState<AppCommands>({});
  const value = useMemo<Ctx>(
    () => ({
      commands,
      register: (c) => {
        setCommands(c);
        // Only clear if this registration is still the current one. A route
        // swap mounts the next screen before unmounting the old one, so an
        // unconditional reset here would wipe the new screen's commands.
        return () => setCommands((prev) => (prev === c ? {} : prev));
      },
    }),
    [commands],
  );
  return (
    <AppCommandsContext.Provider value={value}>{children}</AppCommandsContext.Provider>
  );
}

export function useAppCommands(): AppCommands {
  return useContext(AppCommandsContext)?.commands ?? {};
}

/**
 * Publish this screen's commands to the title bar. Pass a memoised object —
 * it is the effect's dependency, so an unstable one re-registers every render.
 */
export function useRegisterCommands(commands: AppCommands) {
  const ctx = useContext(AppCommandsContext);
  const register = ctx?.register;
  useEffect(() => register?.(commands), [register, commands]);
}
