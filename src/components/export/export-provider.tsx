import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { dismissExport, exportStatus, setLastPage, type ExportStatus } from "@/lib/api";
import { GOTO_PAGE_EVENT, type GotoPageDetail } from "@/lib/app-commands";
import { ExportDialog } from "./export-dialog";
import { ExportView } from "./export-view";

type Ctx = {
  status: ExportStatus | null;
  /** Open the Export dialog for a book, or the progress view if an export is running. */
  openExport: (projectId: string) => void;
  /** Open the progress view or the unseen summary. */
  openView: () => void;
  /** Take the user to a page in the editor, from wherever they are. */
  goToPage: (projectId: string, pageNo: number) => void;
};

const ExportContext = createContext<Ctx | null>(null);

export function useExport(): Ctx {
  const ctx = useContext(ExportContext);
  if (!ctx) throw new Error("useExport outside ExportProvider");
  return ctx;
}

/**
 * The export's state for the whole app. Mounted at the root because an
 * export outlives the screen it was started from: it runs for hours in Rust,
 * and the user may be on Home or in another book when it finishes.
 */
export function ExportProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [dialogProject, setDialogProject] = useState<string | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const statusFromEventRef = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    // Picks up a run already in flight after a webview reload. Guarded so a
    // slow initial fetch can't clobber a status an event already delivered.
    exportStatus().then((s) => {
      if (!statusFromEventRef.current) setStatus(s);
    }, console.error);
    const subs = [
      listen<ExportStatus>("export://progress", (e) => {
        statusFromEventRef.current = true;
        setStatus(e.payload);
      }),
      listen<ExportStatus>("export://finished", (e) => {
        statusFromEventRef.current = true;
        setStatus(e.payload);
      }),
    ];
    return () => {
      for (const s of subs) void s.then((f) => f());
    };
  }, []);

  const running = status?.state === "running";

  const openExport = useCallback(
    (projectId: string) => {
      if (running) {
        setViewOpen(true);
        return;
      }
      // A new export supersedes an unseen result.
      if (status?.state === "finished") {
        dismissExport().catch(console.error);
        setStatus(null);
      }
      setDialogProject(projectId);
    },
    [running, status?.state],
  );

  const openView = useCallback(() => setViewOpen(true), []);

  const goToPage = useCallback(
    (projectId: string, pageNo: number) => {
      setViewOpen(false);
      if (location.pathname === `/project/${projectId}`) {
        window.dispatchEvent(
          new CustomEvent<GotoPageDetail>(GOTO_PAGE_EVENT, { detail: { projectId, pageNo } }),
        );
        return;
      }
      // The editor reopens a book on its remembered page.
      setLastPage(projectId, pageNo)
        .catch(console.error)
        .finally(() => navigate(`/project/${projectId}`));
    },
    [location.pathname, navigate],
  );

  const dismiss = useCallback(() => {
    setViewOpen(false);
    if (status?.state === "finished") {
      dismissExport().catch(console.error);
      setStatus(null);
    }
  }, [status?.state]);

  const value = useMemo<Ctx>(
    () => ({ status, openExport, openView, goToPage }),
    [status, openExport, openView, goToPage],
  );

  return (
    <ExportContext.Provider value={value}>
      {children}
      {dialogProject && (
        <ExportDialog
          projectId={dialogProject}
          onStarted={() => {
            setDialogProject(null);
            setViewOpen(true);
          }}
          onCancel={() => setDialogProject(null)}
        />
      )}
      {viewOpen && status && (
        <ExportView
          status={status}
          onHide={() => setViewOpen(false)}
          onDismiss={dismiss}
          onExportAgain={(projectId) => {
            dismiss();
            setDialogProject(projectId);
          }}
          onGoToPage={goToPage}
        />
      )}
    </ExportContext.Provider>
  );
}
