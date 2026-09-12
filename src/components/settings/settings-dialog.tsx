import { Check, Monitor, Moon, Sun } from "lucide-react";
import { APP_LANGUAGES, useAppLanguage } from "@/lib/app-language";
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

const THEMES: { key: ThemePreference; label: string; icon: typeof Sun; hint: string }[] = [
  { key: "light", label: "Light", icon: Sun, hint: "Always the light palette" },
  { key: "dark", label: "Dark", icon: Moon, hint: "Always the dark palette" },
  { key: "system", label: "System", icon: Monitor, hint: "Follow the desktop" },
];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { preference, setPreference } = useTheme();
  const [language, setLanguage] = useAppLanguage();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-1 sm:max-w-160">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-7 py-3">
          <Section title="Appearance">
            <div className="grid grid-cols-3 gap-2.5">
              {THEMES.map(({ key, label, icon: Icon, hint }) => {
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
                        : "border-line bg-surface text-ink-2 hover:border-line-2 hover:bg-paper-2",
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <Icon size={15} strokeWidth={1.8} />
                      <span className="flex-1 text-[13.5px] font-medium">{label}</span>
                      {active && (
                        <Check size={14} strokeWidth={2.4} className="text-teal-ink" />
                      )}
                    </span>
                    <span className="text-[11.5px] text-ink-3">{hint}</span>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Language">
            <Select
              value={language}
              onValueChange={(v) => setLanguage(v as typeof language)}
            >
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APP_LANGUAGES.map((l) => (
                  <SelectItem key={l.code} value={l.code}>
                    {l.label}
                    {!l.translated && (
                      <span className="text-ink-3"> · not translated yet</span>
                    )}
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
      <h2 className="m-0 mb-3 font-mono text-[10px] tracking-widest text-ink-3 uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}
