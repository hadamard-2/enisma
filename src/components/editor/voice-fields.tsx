import { useTranslation } from "react-i18next";
import { Slider } from "@/components/ui/slider";
import { describeKokoroVoice, singleSpeakerVoice } from "@/lib/voice-label";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-medium uppercase tracking-widest text-ink-3">
        {label}
      </label>
      {children}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </div>
  );
}

export function LabeledSlider({
  value,
  onChange,
  min,
  max,
  step,
  suffix = "",
  disabled = false,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs text-ink-3">
        <span>
          {min}
          {suffix}
        </span>
        <span className="rounded bg-paper-2 px-1.5 py-px font-mono text-[11.5px] font-medium text-ink">
          {value.toFixed(1)}
          {suffix}
        </span>
        <span>
          {max}
          {suffix}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
    </div>
  );
}

/** A Kokoro voice as its name, then accent and gender in a quieter tone. */
export function KokoroVoiceName({ id }: { id: string }) {
  const { t } = useTranslation();
  const v = describeKokoroVoice(id);
  const traits = [
    v.accent && t(`voices.accent.${v.accent}`),
    v.gender && t(`voices.gender.${v.gender}`),
  ].filter(Boolean);
  return (
    <span>
      {v.name}
      {traits.length > 0 && <span className="text-ink-3"> · {traits.join(" · ")}</span>}
    </span>
  );
}

/**
 * The one voice of a single-speaker language, shown as plain text.
 *
 * Deliberately not a disabled dropdown: there is no choice to make, and an
 * inert control would invite the user to look for one.
 */
export function SingleSpeakerVoice({ language }: { language: string }) {
  const { t } = useTranslation();
  const fixed = singleSpeakerVoice(language);
  if (!fixed) return null;
  return (
    <Field label={t("ttsPanel.voice")}>
      <div className="text-sm text-ink">
        {t(fixed.nameKey)}
        <span className="text-ink-3"> · {t(`voices.gender.${fixed.gender}`)}</span>
      </div>
    </Field>
  );
}
