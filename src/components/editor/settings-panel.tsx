import { useEffect, useMemo, useState } from "react";
import { FastForward, Pause, Play, Rewind } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { LANGUAGES, type LanguageCode } from "@/lib/languages";
import { PLACEHOLDER_VOICES } from "@/lib/placeholder-voices";

export function SettingsPanel({
  language,
  setLanguage,
  voice,
  setVoice,
  speed,
  setSpeed,
  playing,
  setPlaying,
  page,
}: {
  language: string;
  setLanguage: (l: string) => void;
  voice: string;
  setVoice: (v: string) => void;
  speed: number;
  setSpeed: (n: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  page: number;
}) {
  const voices = PLACEHOLDER_VOICES[language as LanguageCode] ?? [];

  useEffect(() => {
    if (!voices.includes(voice) && voices[0]) setVoice(voices[0]);
  }, [language, voice, voices, setVoice]);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper-2">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-4.5 pt-4 pb-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
          Audio settings
        </div>
        <div className="font-serif text-lg font-medium text-ink">
          Text-to-speech
        </div>
        <div className="mt-1 text-xs text-ink-3">
          Applied to all pages in this project.
        </div>
      </div>

      <div className="my-2 h-px bg-line" />

      <div className="flex flex-col gap-4 px-4.5 py-2">
        <Field label="Language">
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
        </Field>

        <Field label="Voice">
          <Select value={voice} onValueChange={setVoice}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {voices.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Speaking rate">
          <LabeledSlider
            value={speed}
            onChange={setSpeed}
            min={0.5}
            max={2.0}
            step={0.1}
            suffix="×"
          />
        </Field>
      </div>

      <div className="mt-3 h-px bg-line" />

      <div className="px-4.5 py-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-3">
          Page {page}
        </div>

        <div className="rounded-xl border border-line bg-surface p-3.5 shadow-paper-sm">
          <Waveform playing={playing} />

          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-3">
            <span>{playing ? "0:14" : "0:00"}</span>
            <span>1:42</span>
          </div>

          {/* The play button is centred on the card, not on the row: the
              side controls are laid out around it rather than sharing the
              space with it. */}
          <div className="relative mt-2.5 flex items-center justify-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Rewind"
              className="text-ink-2"
            >
              <Rewind />
            </Button>
            <button
              onClick={() => setPlaying(!playing)}
              aria-label={playing ? "Pause preview" : "Play preview"}
              className="grid size-10 cursor-pointer place-items-center rounded-full bg-teal text-surface shadow-paper-sm transition-colors hover:bg-teal-ink"
            >
              {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Forward"
              className="text-ink-2"
            >
              <FastForward />
            </Button>
          </div>
        </div>

      </div>
      </div>

    </aside>
  );
}

function Field({
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

function LabeledSlider({
  value,
  onChange,
  min,
  max,
  step,
  suffix = "",
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step: number;
  suffix?: string;
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
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
    </div>
  );
}

function Waveform({ playing }: { playing: boolean }) {
  const BARS = 36;
  const heights = useMemo(
    () =>
      Array.from({ length: BARS }, (_, i) => {
        const t = i / BARS;
        return (
          0.3 +
          0.7 *
            Math.abs(Math.sin(t * 11) * Math.cos(t * 5)) *
            (0.6 + 0.4 * Math.sin(t * 19))
        );
      }),
    [],
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [playing]);

  return (
    <div className="mt-0.5 flex h-8 items-center gap-0.5">
      {heights.map((h, i) => {
        const playedRatio = playing ? ((tick + i) % BARS) / BARS : 0.25;
        const isPlayed = i / BARS < playedRatio;
        return (
          <div
            key={i}
            className={cn(
              "flex-1 rounded-sm transition-colors duration-200",
              isPlayed ? "bg-teal" : "bg-line-2",
            )}
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
