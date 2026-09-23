import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cancelExport } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Ask before a window close kills an export that has been running for hours.
 *
 * Listens only while an export runs: `onCloseRequested` destroys the window
 * itself when the handler lets a close through, so a listener left mounted at
 * other times would add nothing but a second path to the same close.
 */
export function QuitGuard({ running }: { running: boolean }) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!running || !isTauri()) return;
    const unlisten = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      setAsking(true);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [running]);

  async function quit() {
    await cancelExport().catch(console.error);
    await getCurrentWindow().destroy();
  }

  if (!asking) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && setAsking(false)}>
      <DialogContent className="grid-cols-1 sm:max-w-110">
        <DialogHeader>
          <DialogTitle className="font-serif">{t("export.quitTitle")}</DialogTitle>
          <DialogDescription>{t("export.quitBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t-0">
          <Button variant="outline" onClick={() => setAsking(false)}>
            {t("export.keepExporting")}
          </Button>
          <Button onClick={quit}>{t("export.quitAnyway")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
