import { useTranslation } from "react-i18next";
import { CloudDownload, FolderInput, HardDriveDownload, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes, installedFraction, primaryAction, type ModelPanelState } from "@/lib/model-state";
import type { ModelStatus } from "@/lib/api";

/**
 * Standing in for the Convert button when this book's language has no usable
 * voice yet.
 *
 * It takes Convert's place rather than sitting beside it because the two are
 * the same decision at different stages: the user came here to hear the page,
 * and this is what has to happen first. Showing a disabled Convert alongside
 * would leave them looking for the reason.
 */
export function ModelPanel({
  state,
  languageLabel,
  status,
  progress,
  error,
  cancelling,
  onDownload,
  onImport,
  onCancel,
}: {
  state: Exclude<ModelPanelState, "ready">;
  /** The language's own display name, already translated. */
  languageLabel: string;
  /** This language's row from `modelStatus()`, or null while none is known. */
  status: ModelStatus | null;
  /** Fraction 0-1 from the last `models://progress` event. */
  progress: number;
  /** Untranslated message from an install that failed, or null. */
  error: string | null;
  /** A stop has been requested but the install has not settled yet. */
  cancelling: boolean;
  onDownload: () => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const total = status ? formatBytes(status.bytes) : "";
  const already = status ? formatBytes(status.installedBytes + status.partialBytes) : "";

  if (state === "installing") {
    // Live progress once the first event lands; until then, what is already on
    // disk — so a resumed download does not show an empty bar for a second.
    const fraction = progress > 0 ? progress : status ? installedFraction(status) : 0;
    return (
      <Card>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <HardDriveDownload size={15} className="animate-pulse text-teal" />
          {t("modelPanel.installing", { language: languageLabel })}
        </div>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line-2">
          <div
            className="h-full rounded-full bg-teal transition-[width] duration-300"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
          />
        </div>
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[11px] text-ink-3">
            {t("modelPanel.installingSize", { total })}
          </span>
          {/* Cheap to press: what has arrived is kept, and asking again
              resumes from there rather than starting the download over. */}
          <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
            {t(cancelling ? "modelPanel.cancelling" : "modelPanel.cancel")}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        {state === "error" || state === "unloadable" ? (
          <TriangleAlert size={15} className="text-amber-ink" />
        ) : (
          <CloudDownload size={15} className="text-ink-3" />
        )}
        {t("modelPanel.heading", { language: languageLabel })}
      </div>

      <p className="mt-1.5 mb-0 text-[12.5px] leading-relaxed text-ink-2">
        {state === "unloadable"
          ? t("modelPanel.unloadable")
          : state === "partial"
            ? t("modelPanel.partial", { already, total })
            : t("modelPanel.missing", { total })}
      </p>

      {/* The sidecar's own words, deliberately untranslated — a checksum
          failure or the names of the files a folder was missing. */}
      {state === "error" && error !== null && (
        <p className="mt-1.5 mb-0 text-[12px] text-amber-ink">
          {t("modelPanel.failed", { error })}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button onClick={onDownload} className="flex-1">
          {t(`modelPanel.${primaryAction(state) ?? "download"}`)}
        </Button>
        {/* The whole point of the offline design: a machine that cannot
            download can still be given the same files on a stick. */}
        <Button variant="outline" onClick={onImport} title={t("modelPanel.importTooltip")}>
          <FolderInput size={14} />
          {t("modelPanel.import")}
        </Button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 shadow-paper-sm">
      {children}
    </div>
  );
}
