import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useModels } from "@/components/models/models-provider";
import { languageLabelKey } from "@/lib/languages";

/**
 * Confirm deleting a language's voice model.
 *
 * The body says plainly what is and is not lost: audio already made is plain
 * WAV and keeps playing, and only making new audio needs the model again.
 * Without that, deleting reads as though it might take the user's work with it.
 */
export function DeleteVoiceDialog({
  language,
  size,
  onClose,
}: {
  language: string;
  /** Already formatted, e.g. "114 MB". */
  size: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { removeLanguage } = useModels();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = t(languageLabelKey(language));

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeLanguage(language);
      onClose();
    } catch (e) {
      // The backend's own words, untranslated: "in use", or what is running.
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="grid-cols-1 sm:max-w-120">
        <DialogHeader>
          <DialogTitle className="font-serif">{t("deleteVoice.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            {t("deleteVoice.body", { language: name, size })}
          </p>
          {error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {error}
            </div>
          )}
        </div>
        <DialogFooter className="border-t-0">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("deleteVoice.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {t("deleteVoice.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
