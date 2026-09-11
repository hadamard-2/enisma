import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGES } from "@/lib/languages";
import { importProject } from "@/lib/api";

export function ImportDialog({
  srcPath,
  onCancel,
  onImported,
}: {
  srcPath: string | null;
  onCancel: () => void;
  onImported: (id: string) => void;
}) {
  const stem = srcPath?.split(/[/\\]/).pop()?.replace(/\.pdf$/i, "") ?? "";
  const [title, setTitle] = useState(stem);
  const [language, setLanguage] = useState<string>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!srcPath || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await importProject(title.trim(), language, srcPath));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={srcPath !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="grid-cols-1 sm:max-w-120">
        <DialogHeader>
          <DialogTitle className="font-serif">Import a textbook</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-widest text-ink-3">
              Title
            </label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-medium uppercase tracking-widest text-ink-3">
              Language
            </label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="truncate font-mono text-[11px] text-ink-3" title={srcPath ?? undefined}>
            {srcPath}
          </div>

          {error && (
            <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="border-t-0">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={busy || !title.trim()}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
