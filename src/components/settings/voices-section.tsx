import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModels } from "@/components/models/models-provider";
import { LANGUAGES, languageLabelKey } from "@/lib/languages";
import {
  canDelete,
  canImportFromFolder,
  formatBytes,
  installLocked,
  installedFraction,
  languageState,
  primaryAction,
} from "@/lib/model-state";
import { DeleteVoiceDialog } from "./delete-voice-dialog";

/**
 * One row per textbook language: what its voice model has on disk, and the
 * few things that can be done about it. The editor offers the same install
 * next to Convert; this is where a model can be looked after without opening
 * a book in that language, and the only place one can be deleted.
 */
export function VoicesSection() {
  const { t } = useTranslation();
  const models = useModels();
  const [deleting, setDeleting] = useState<{ language: string; size: string } | null>(null);

  if (models.rows === null) {
    return <p className="m-0 text-[12.5px] text-ink-3">{t("settings.voicesUnavailable")}</p>;
  }

  const busy = installLocked(models.install);

  return (
    <>
      <div className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
        {LANGUAGES.map(({ code }) => {
          const row = models.rows?.find((r) => r.language === code) ?? null;
          if (row === null) return null;
          const state = languageState(models.snapshot, code);
          const action = primaryAction(state);
          const onDisk = formatBytes(row.installedBytes + row.partialBytes);
          const installing = models.install?.language === code ? models.install : null;
          const fraction = installing
            ? installing.progress > 0
              ? installing.progress
              : installedFraction(row)
            : 0;

          return (
            <div key={code} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-ink">{t(languageLabelKey(code))}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">
                  {state === "installing" &&
                    t("settings.voiceInstalling", { percent: Math.round(fraction * 100) })}
                  {state === "ready" && t("settings.voiceInstalled", { size: formatBytes(row.bytes) })}
                  {state === "missing" && t("settings.voiceMissing", { size: formatBytes(row.bytes) })}
                  {state === "partial" &&
                    t("settings.voicePartial", { already: onDisk, total: formatBytes(row.bytes) })}
                  {state === "unloadable" && (
                    <span className="text-amber-ink">{t("settings.voiceUnloadable")}</span>
                  )}
                  {/* The backend's own words, deliberately untranslated. */}
                  {state === "error" && models.error && (
                    <span className="text-amber-ink">
                      {t("modelPanel.failed", { error: models.error.message })}
                    </span>
                  )}
                </div>
                {state === "installing" && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-line-2">
                    <div
                      className="h-full rounded-full bg-teal transition-[width] duration-300"
                      style={{ width: `${Math.round(fraction * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {installing ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={models.cancelInstall}
                    disabled={installing.cancelling}
                  >
                    {t(installing.cancelling ? "modelPanel.cancelling" : "modelPanel.cancel")}
                  </Button>
                ) : (
                  <>
                    {action && (
                      <Button size="sm" onClick={() => void models.installModel(code)} disabled={busy}>
                        {t(`modelPanel.${action}`)}
                      </Button>
                    )}
                    {canImportFromFolder(state) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void models.installFromFolder(code)}
                        disabled={busy}
                        title={t("modelPanel.importTooltip")}
                      >
                        <FolderInput />
                        {t("modelPanel.import")}
                      </Button>
                    )}
                    {canDelete(row, state) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleting({ language: code, size: onDisk })}
                        aria-label={t("settings.voiceDelete")}
                        title={t("settings.voiceDelete")}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {deleting && (
        <DeleteVoiceDialog
          language={deleting.language}
          size={deleting.size}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
