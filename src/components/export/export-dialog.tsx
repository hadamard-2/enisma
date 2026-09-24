import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { dirname, join } from "@tauri-apps/api/path";
import {
  exportPlan,
  getProject,
  listVoices,
  startExport,
  type ExportPlan,
  type ProjectDetail,
} from "@/lib/api";
import {
  compactPages,
  defaultFileName,
  exportDefaults,
  pagesOf,
  withMp3Extension,
  type ExportForm,
} from "@/lib/export-form";
import { languageLabelKey } from "@/lib/languages";
import { sidecarHealth } from "@/lib/platform";
import { reconcileVoice } from "@/lib/voice-selection";
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
import {
  Field,
  KokoroVoiceName,
  LabeledSlider,
  SingleSpeakerVoice,
} from "@/components/editor/voice-fields";

/**
 * Choose voice, speed and pages, then where to save, then start.
 *
 * Mounted only while open, so every field starts from a fresh read of the
 * project rather than an effect syncing state to props.
 */
export function ExportDialog({
  projectId,
  onStarted,
  onCancel,
}: {
  projectId: string;
  onStarted: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [form, setForm] = useState<ExportForm | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  // Null while unknown: a sidecar mid-restart must not flash "install the voice".
  const [engineUp, setEngineUp] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getProject(projectId);
        if (cancelled) return;
        setProject(p);
        const defaults = exportDefaults(p);
        const list = await listVoices(p.language).catch(() => [] as string[]);
        if (cancelled) return;
        setVoices(list);
        setForm({ ...defaults, voice: reconcileVoice(list, defaults.voice).voice });
        sidecarHealth().then(
          (h) => !cancelled && setEngineUp(Boolean(h.engines[p.language])),
          () => {},
        );
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const pages = project && form ? pagesOf(form, project.pageCount) : null;
  const valid = !!pages;
  // A stable dependency for the plan effect; the array is rebuilt every render.
  const pagesKey = pages?.join(",") ?? "";

  useEffect(() => {
    if (!project || !form || !pages) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    exportPlan(project.id, form.voice, form.rate, pages).then(
      (p) => {
        if (cancelled) return;
        setPlan(p);
        // A plan that arrives supersedes an earlier plan request's failure.
        setError(null);
      },
      (e: unknown) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
    // `pages` is derived; `pagesKey` is its real dependency.
  }, [project?.id, form?.voice, form?.rate, pagesKey]);

  const nothing = !!plan && plan.ready + plan.toSynthesize === 0;
  const blockedOnModel = !!plan && plan.toSynthesize > 0 && engineUp === false;
  const canStart = !!plan && valid && !nothing && !blockedOnModel && !busy;

  const update = (patch: Partial<ExportForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function pickAndStart() {
    if (!project || !form || !pages || !canStart) return;
    // `pages` is distinct and inside the book, so full length means every page.
    const whole = pages.length === project.pageCount;
    const name = defaultFileName(project.title, whole ? null : compactPages(pages));
    const picked = await save({
      defaultPath: await suggestedPath(form.path, name),
      filters: [{ name: "MP3", extensions: ["mp3"] }],
    });
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await startExport(
        project.id,
        form.voice,
        form.rate,
        pages,
        withMp3Extension(picked),
      );
      onStarted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="grid-cols-1 p-6 sm:max-w-120">
        <DialogHeader>
          <DialogTitle className="font-serif">{t("export.title")}</DialogTitle>
        </DialogHeader>

        {project && form && (
          <div className="flex flex-col gap-6 py-2">
            {voices.length > 0 ? (
              <Field label={t("export.voice")}>
                <Select value={form.voice} onValueChange={(voice) => update({ voice })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {voices.map((v) => (
                      <SelectItem key={v} value={v}>
                        <KokoroVoiceName id={v} />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <SingleSpeakerVoice language={project.language} />
            )}

            <Field label={t("export.speed")}>
              <LabeledSlider
                value={form.rate}
                onChange={(rate) => update({ rate })}
                min={0.5}
                max={2.0}
                step={0.1}
                suffix="×"
              />
            </Field>

            <Field label={t("export.pages")}>
              <div className="flex flex-col gap-2 text-sm text-ink">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={form.wholeBook}
                    onChange={() => update({ wholeBook: true })}
                  />
                  {t("export.wholeBook")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={!form.wholeBook}
                    onChange={() => update({ wholeBook: false })}
                  />
                  {t("export.pageRange")}
                  <Input
                    className="flex-1"
                    placeholder={t("export.pagesPlaceholder")}
                    value={form.pagesText}
                    disabled={form.wholeBook}
                    onChange={(e) => update({ pagesText: e.target.value })}
                  />
                </label>
              </div>
            </Field>

            <div className="text-[12.5px] text-ink-2">
              {!valid
                ? t("export.invalidRange")
                : plan &&
                  t("export.plan", {
                    total: plan.total,
                    ready: plan.ready,
                    toSynthesize: plan.toSynthesize,
                    empty: plan.empty.length,
                  })}
            </div>
            {plan && plan.replacing > 0 && (
              <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
                {t("export.replacing", { count: plan.replacing })}
              </div>
            )}
            {nothing && <div className="text-[12.5px] text-ink-3">{t("export.nothingToExport")}</div>}
            {blockedOnModel && (
              <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
                {t("export.modelMissing", { language: t(languageLabelKey(project.language)) })}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-line bg-paper-2 px-3 py-2 text-[12.5px] text-amber-ink">
            {error}
          </div>
        )}

        <DialogFooter className="-mx-6 -mb-6 border-t-0 p-6 pt-4">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("export.cancel")}
          </Button>
          <Button onClick={pickAndStart} disabled={!canStart}>
            {t("export.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The last export's folder with this export's name, else just the name. */
async function suggestedPath(lastPath: string | null, name: string): Promise<string> {
  if (!lastPath) return name;
  try {
    return await join(await dirname(lastPath), name);
  } catch {
    return name;
  }
}
