import { useTranslation } from "react-i18next";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { APP_LANGUAGES, appLanguageLabelKey, useAppLanguage } from "@/lib/app-language";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const THEMES: { key: ThemePreference; labelKey: string; icon: typeof Sun; hintKey: string }[] = [
  { key: "light", labelKey: "settings.themeLight", icon: Sun, hintKey: "settings.themeLightHint" },
  { key: "dark", labelKey: "settings.themeDark", icon: Moon, hintKey: "settings.themeDarkHint" },
  { key: "system", labelKey: "settings.themeSystem", icon: Monitor, hintKey: "settings.themeSystemHint" },
];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const [language, setLanguage] = useAppLanguage();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-1 sm:max-w-160">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-7 py-3">
          <Section title={t("settings.appearance")}>
            <div className="grid grid-cols-3 gap-2.5">
              {THEMES.map(({ key, labelKey, icon: Icon, hintKey }) => {
                const active = preference === key;
                return (
                  <button
                    key={key}
                    onClick={() => setPreference(key)}
                    aria-pressed={active}
                    className={cn(
                      "flex cursor-pointer flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors",
                      active
                        ? "border-teal bg-teal-soft text-ink"
                        : "border-ink-4 bg-paper-2 text-ink-2 hover:border-ink-3 hover:bg-paper-3",
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <Icon size={15} strokeWidth={1.8} />
                      <span className="flex-1 text-[13.5px] font-medium">{t(labelKey)}</span>
                      {active && (
                        <Check size={14} strokeWidth={2.4} className="text-teal-ink" />
                      )}
                    </span>
                    <span className="text-[12px] text-ink-2">{t(hintKey)}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title={t("settings.language")}>
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as typeof language)}
            >
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APP_LANGUAGES.map((l) => (
                  // The option list is only as wide as the trigger, so the
                  // longer "not translated yet" rows are ellipsised rather
                  // than allowed to run onto a second line. One span keeps
                  // the label and the note as a single truncatable run.
                  <SelectItem
                    key={l.code}
                    value={l.code}
                    className="[&>span:last-child]:min-w-0"
                  >
                    <span className="truncate">
                      {t(appLanguageLabelKey(l.code))}
                      {!l.translated && (
                        <span className="text-ink-2">{t("settings.notTranslated")}</span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="m-0 mb-3 font-mono text-[11.5px] tracking-widest text-ink-2 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
