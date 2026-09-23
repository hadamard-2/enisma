import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { cancelExport, type ExportStatus, type RunningExport } from "@/lib/api";
import { formatClock, overallFraction, timeLeftMs } from "@/lib/export-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProgressBar } from "@/components/ui/progress-bar";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The export's progress while it runs, and its summary once it ends. */
export function ExportView({
  status,
  onHide,
  onDismiss,
  onExportAgain,
  onGoToPage,
}: {
  status: ExportStatus;
  onHide: () => void;
  onDismiss: () => void;
  onExportAgain: (projectId: string) => void;
  onGoToPage: (projectId: string, pageNo: number) => void;
}) {
  const running = status.state === "running";
  return (
    <Dialog open onOpenChange={(o) => !o && (running ? onHide() : onDismiss())}>
      <DialogContent className="grid-cols-1 sm:max-w-120">
        {status.state === "running" ? (
          <Progress status={status} onHide={onHide} />
        ) : (
          <Summary
            status={status}
            onDismiss={onDismiss}
            onExportAgain={onExportAgain}
            onGoToPage={onGoToPage}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Progress({ status, onHide }: { status: RunningExport; onHide: () => void }) {
  const { t } = useTranslation();
  const now = useNow(1000);
  const [stopping, setStopping] = useState(false);
  const elapsed = now - status.startedAtMs;
  const left =
    status.phase === "stitching"
      ? null
      : timeLeftMs(elapsed, status.synthesized, status.total - status.done);

  const phase =
    status.phase === "stitching"
      ? t("export.phaseWriting")
      : status.pageNo === null
        ? t("export.phaseStarting")
        : status.phase === "sweeping"
          ? t("export.phaseChecking", { page: status.pageNo })
          : t("export.phaseReading", {
              page: status.pageNo,
              done: status.done + 1,
              total: status.total,
            });

  function stop() {
    setStopping(true);
    cancelExport().catch((e: unknown) => {
      console.error(e);
      setStopping(false);
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-serif">
          {t("export.progressTitle", { title: status.title })}
        </DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3 py-2">
        <div className="text-[13px] text-ink-2">{phase}</div>
        <ProgressBar value={overallFraction(status) * 100} total={100} />
        {status.phase !== "stitching" && status.pageNo !== null && (
          <ProgressBar value={status.pageProgress * 100} total={100} className="h-0.5" />
        )}
        <div className="flex justify-between text-[12px] text-ink-3">
          <span>{t("export.elapsed", { time: formatClock(elapsed) })}</span>
          {left !== null && <span>{t("export.timeLeft", { time: formatClock(left) })}</span>}
        </div>
      </div>
      <DialogFooter className="border-t-0">
        <Button variant="outline" onClick={stop} disabled={stopping}>
          {stopping ? t("export.stopping") : t("export.stop")}
        </Button>
        <Button onClick={onHide}>{t("export.hide")}</Button>
      </DialogFooter>
    </>
  );
}

function Summary({
  status,
  onDismiss,
  onExportAgain,
  onGoToPage,
}: {
  status: Extract<ExportStatus, { state: "finished" }>;
  onDismiss: () => void;
  onExportAgain: (projectId: string) => void;
  onGoToPage: (projectId: string, pageNo: number) => void;
}) {
  const { t } = useTranslation();
  const o = status.outcome;
  const emptyNote = (empty: number[]) =>
    empty.length > 0 && (
      <div className="text-[12.5px] text-ink-3">
        {t("export.emptyPages", { count: empty.length, pages: empty.join(", ") })}
      </div>
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-serif">
          {o.kind === "done"
            ? t("export.doneTitle")
            : o.kind === "failed"
              ? t("export.failedTitle")
              : o.kind === "cancelled"
                ? t("export.cancelledTitle")
                : t("export.errorTitle")}
        </DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-3 py-2 text-[13px] text-ink-2">
        {o.kind === "done" && (
          <>
            <div className="break-all">{t("export.savedTo", { path: o.path })}</div>
            <div>{t("export.duration", { time: formatClock(o.durationMs) })}</div>
            {emptyNote(o.empty)}
          </>
        )}
        {o.kind === "failed" && (
          <>
            <div>{t("export.failedBody")}</div>
            <ul className="flex flex-col gap-1.5">
              {o.pages.map((p) => (
                <li key={p.pageNo} className="flex flex-col">
                  <button
                    className="self-start text-teal underline-offset-2 hover:underline"
                    onClick={() => onGoToPage(status.projectId, p.pageNo)}
                  >
                    {t("export.pageLink", { n: p.pageNo })}
                  </button>
                  <span className="text-[12px] text-ink-3">{p.message}</span>
                </li>
              ))}
            </ul>
            {emptyNote(o.empty)}
          </>
        )}
        {o.kind === "cancelled" && <div>{t("export.cancelledBody", { count: o.kept })}</div>}
        {o.kind === "error" && (
          <>
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {o.message}
            </div>
            <div>{t("export.errorBody")}</div>
          </>
        )}
      </div>

      <DialogFooter className="border-t-0">
        {o.kind === "done" && (
          <Button variant="outline" onClick={() => revealItemInDir(o.path).catch(console.error)}>
            {t("export.showInFolder")}
          </Button>
        )}
        {o.kind === "failed" && (
          <Button variant="outline" onClick={() => onExportAgain(status.projectId)}>
            {t("export.again")}
          </Button>
        )}
        <Button onClick={onDismiss}>{t("export.close")}</Button>
      </DialogFooter>
    </>
  );
}
