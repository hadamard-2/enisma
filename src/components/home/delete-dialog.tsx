import { useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteProject, type ProjectSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirm deleting a project.
 *
 * The body names the project and says plainly what goes with it, because this
 * is the app's only irreversible action: the row, its pages, and Enisma's own
 * copy of the PDF. The file the user imported from is not touched, and the copy
 * says so — otherwise the dialog reads as though it might delete their book.
 */
export function DeleteDialog({
  project,
  onDeleted,
  onCancel,
}: {
  project: ProjectSummary;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProject(project.id);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="grid-cols-1 sm:max-w-120">
        <DialogHeader>
          <DialogTitle className="font-serif">{t("deleteProject.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            {t("deleteProject.body", { title: project.title })}
          </p>

          {error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="border-t-0">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("deleteProject.cancel")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {t("deleteProject.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
