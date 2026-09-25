import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  acquireModel,
  cancelModelAcquisition,
  MODEL_INSTALL_CANCELLED,
  modelStatus,
  removeModel,
  type ModelStatus,
} from "@/lib/api";
import type { ModelsSnapshot } from "@/lib/model-state";
import { sidecarHealth } from "@/lib/platform";

type Install = { language: string; progress: number; cancelling: boolean };

type ModelsCtx = {
  rows: ModelStatus[] | null;
  engines: Record<string, unknown> | null;
  install: Install | null;
  error: { language: string; message: string } | null;
  version: number;
  snapshot: ModelsSnapshot;
  refresh: () => void;
  installModel: (language: string, sourceDir?: string) => Promise<void>;
  installFromFolder: (language: string) => Promise<void>;
  cancelInstall: () => void;
  removeLanguage: (language: string) => Promise<void>;
};

const ModelsContext = createContext<ModelsCtx | null>(null);

export function useModels(): ModelsCtx {
  const ctx = useContext(ModelsContext);
  if (!ctx) throw new Error("useModels outside ModelsProvider");
  return ctx;
}

/**
 * Voice-model state for the whole app. Mounted at the root because an install
 * outlives the screen it was started from: one begun in a book keeps running
 * when the user goes back to Home, and Settings has to show it — and one begun
 * in Settings has to show in the book it was for.
 */
export function ModelsProvider({ children }: { children: React.ReactNode }) {
  const [rows, setRows] = useState<ModelStatus[] | null>(null);
  // Null while unknown: the sidecar rejects with "sidecar starting" during a
  // restart, and treating that as "no engines" would flash a load-failure
  // warning over a model that is perfectly fine.
  const [engines, setEngines] = useState<Record<string, unknown> | null>(null);
  const [install, setInstall] = useState<Install | null>(null);
  const [error, setError] = useState<{ language: string; message: string } | null>(null);
  const [version, setVersion] = useState(0);
  // The install in flight, readable synchronously so a double click cannot
  // start two and Cancel always names the right language.
  const installingRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    // Two questions with two answers: what is on disk, and what actually
    // loaded. A model can verify and still fail to load.
    modelStatus().then(setRows, (e: unknown) => {
      console.error(e);
      setRows(null);
    });
    sidecarHealth().then(
      (h) => setEngines(h.engines ?? {}),
      () => setEngines(null),
    );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ language: string; progress: number }>("models://progress", (e) => {
      setInstall((cur) =>
        cur && cur.language === e.payload.language ? { ...cur, progress: e.payload.progress } : cur,
      );
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const settled = useCallback(() => {
    // Whatever happened, what is on disk has moved: a cancel leaves resumable
    // bytes, a success brings the language up, a delete takes it away.
    refresh();
    setVersion((n) => n + 1);
  }, [refresh]);

  const installModel = useCallback(
    async (language: string, sourceDir?: string) => {
      if (installingRef.current !== null) return;
      installingRef.current = language;
      setError((cur) => (cur?.language === language ? null : cur));
      setInstall({ language, progress: 0, cancelling: false });
      try {
        await acquireModel(language, sourceDir);
      } catch (e: unknown) {
        const message = String(e);
        // A cancellation is an outcome the user asked for, not a failure.
        if (message !== MODEL_INSTALL_CANCELLED) setError({ language, message });
      } finally {
        installingRef.current = null;
        setInstall(null);
        settled();
      }
    },
    [settled],
  );

  const installFromFolder = useCallback(
    async (language: string) => {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") await installModel(language, picked);
    },
    [installModel],
  );

  const cancelInstall = useCallback(() => {
    const language = installingRef.current;
    if (language === null) return;
    // Optimistic, as a conversion's cancel is: the request is what the user
    // performed. `installModel`'s `finally` is what ends the install.
    setInstall((cur) => (cur ? { ...cur, cancelling: true } : cur));
    cancelModelAcquisition(language).catch((e: unknown) => {
      console.error(e);
      setInstall((cur) => (cur ? { ...cur, cancelling: false } : cur));
    });
  }, []);

  const removeLanguage = useCallback(
    async (language: string) => {
      try {
        await removeModel(language);
        setError((cur) => (cur?.language === language ? null : cur));
      } finally {
        settled();
      }
    },
    [settled],
  );

  const snapshot = useMemo<ModelsSnapshot>(
    () => ({ rows, engines, installing: install?.language ?? null, error }),
    [rows, engines, install?.language, error],
  );

  const value = useMemo<ModelsCtx>(
    () => ({
      rows,
      engines,
      install,
      error,
      version,
      snapshot,
      refresh,
      installModel,
      installFromFolder,
      cancelInstall,
      removeLanguage,
    }),
    [rows, engines, install, error, version, snapshot, refresh, installModel, installFromFolder, cancelInstall, removeLanguage],
  );

  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>;
}
