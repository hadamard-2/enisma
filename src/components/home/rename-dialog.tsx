import { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateProject, type ProjectSummary } from "@/lib/api";
import { validateTitle } from "@/lib/rename";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Change a project's title.
 *
 * Mounted with `project` non-null only while renaming, so the input's initial
 * value comes from a fresh mount rather than an effect syncing state to props.
 * The rule for what may be saved lives in `validateTitle`, which is tested.
 */
export function RenameDialog({
  project,
  onRenamed,
  onCancel,
}: {
  project: ProjectSummary;
  onRenamed: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = validateTitle(title, project.title);

  async function save() {
    if (!check.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateProject(project.id, { title: check.title });
      onRenamed();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="grid-cols-1 sm:max-w-120">
        <DialogHeader>
          <DialogTitle className="font-serif">{t("rename.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-widest text-ink-3">
              {t("rename.field")}
            </label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              disabled={busy}
            />
          </div>

          {error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="border-t-0">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("rename.cancel")}
          </Button>
          <Button onClick={save} disabled={busy || !check.ok}>
            {t("rename.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
