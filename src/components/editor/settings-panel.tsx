import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AudioLines, FastForward, Pause, Play, Rewind } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
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
import { LANGUAGES, languageLabelKey } from "@/lib/languages";
import { audioStateFor, formatDuration } from "@/lib/audio-state";
import type { PageAudio } from "@/lib/api";

/** How far the rewind and forward buttons jump, in seconds. */
const SKIP_SECONDS = 10;

export function SettingsPanel({
  language,
  setLanguage,
  voices,
  voice,
  setVoice,
  speed,
  setSpeed,
  playing,
  setPlaying,
  page,
  audio,
  hasText,
  converting,
  cancelling,
  progress,
  convertError,
  onConvert,
  onCancel,
}: {
  language: string;
  setLanguage: (l: string) => void;
  /** The voices this language offers. Empty for a single-speaker language. */
  voices: string[];
  voice: string;
  setVoice: (v: string) => void;
  speed: number;
  setSpeed: (n: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  page: number;
  /** The stored take for this page, or null while none is known. */
  audio: PageAudio | null;
  hasText: boolean;
  converting: boolean;
  /** A stop has been requested but the conversion has not settled yet. */
  cancelling: boolean;
  /** Fraction 0-1 from the last `tts://progress` event. */
  progress: number;
  /** Untranslated message from a conversion that failed, or null. */
  convertError: string | null;
  onConvert: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  const state = audioStateFor({
    path: audio?.path ?? null,
    stale: audio?.stale ?? true,
    converting,
    hasText,
    error: convertError,
  });

  const path = audio?.path ?? null;
  const src = path ? convertFileSrc(path) : null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [position, setPosition] = useState(0);

  // A new take — or a different page — starts from the beginning, and must
  // never leave the previous one still playing behind the new label.
  useEffect(() => {
    setPosition(0);
    setPlaying(false);
    const el = audioRef.current;
    if (el) el.currentTime = 0;
  }, [src, setPlaying]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, src, setPlaying]);

  function skip(seconds: number) {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, el.currentTime + seconds);
    setPosition(el.currentTime);
  }

  // The stored duration is what the panel promises before playback starts;
  // the element's own duration is only known once metadata has loaded.
  const total = formatDuration(audio?.durationMs ?? null);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-paper-2">
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-4.5 pt-4 pb-2">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
          {t("ttsPanel.sectionLabel")}
        </div>
        <div className="font-serif text-lg font-medium text-ink">
          {t("ttsPanel.heading")}
        </div>
        <div className="mt-1 text-xs text-ink-3">
          {t("ttsPanel.subtitle")}
        </div>
      </div>

      <div className="my-2 h-px bg-line" />

      <div className="flex flex-col gap-4 px-4.5 py-2">
        <Field label={t("ttsPanel.language")}>
          <Select value={language} onValueChange={setLanguage} disabled={converting}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code}>
                  {t(languageLabelKey(l.code))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* Hidden rather than disabled when there is nothing to choose: the
            single-speaker languages have one voice, and an inert dropdown
            would invite the user to look for a choice that does not exist. */}
        {voices.length > 0 && (
          <Field label={t("ttsPanel.voice")}>
            <Select value={voice} onValueChange={setVoice} disabled={converting}>
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
        )}

        <Field label={t("ttsPanel.speakingRate")}>
          <LabeledSlider
            value={speed}
            onChange={setSpeed}
            min={0.5}
            max={2.0}
            step={0.1}
            suffix="×"
            disabled={converting}
          />
        </Field>
      </div>

      <div className="mt-3 h-px bg-line" />

      <div className="px-4.5 py-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-ink-3">
          {t("ttsPanel.page", { n: page })}
        </div>

        {/* Stage one: ask for the audio. Conversion is never automatic — it
            costs 40-100 seconds — so this is the panel's loudest control. */}
        <div className="mb-3">
          {state === "converting" ? (
            <div className="rounded-xl border border-line bg-surface p-3.5 shadow-paper-sm">
              <div className="flex items-center gap-2 text-[13px] text-ink-2">
                <AudioLines size={15} className="animate-pulse text-teal" />
                {t("ttsPanel.converting", { n: page })}
              </div>
              <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line-2">
                <div
                  className="h-full rounded-full bg-teal transition-[width] duration-300"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
                />
              </div>
              <div className="mt-2.5 flex justify-end">
                {/* Pressing Cancel only *asks* the engine to stop; it reads the
                    flag between chunks, so the button becomes a status line
                    rather than disappearing, and stays until the conversion
                    itself settles — which it may do by finishing normally. */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onCancel}
                  disabled={cancelling}
                >
                  {t(cancelling ? "ttsPanel.cancelling" : "ttsPanel.cancel")}
                </Button>
              </div>
            </div>
          ) : state === "noText" ? (
            <div className="text-[13px] text-ink-3">{t("ttsPanel.noText")}</div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {/* Offered for a page with no take, one whose take no longer
                    matches, and one whose conversion failed. A take that is
                    already current has nothing to gain from being remade, and
                    would cost another 40-100 seconds to find that out. */}
                <Button
                  onClick={onConvert}
                  disabled={!hasText || state === "fresh"}
                  className="flex-1"
                >
                  {t(state === "error" ? "ttsPanel.retry" : "ttsPanel.convert")}
                </Button>
                {state === "stale" && (
                  <span className="rounded bg-paper-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">
                    {t("ttsPanel.stale")}
                  </span>
                )}
              </div>
              {/* The engine's own words, deliberately untranslated. */}
              {state === "error" && convertError !== null && (
                <div className="text-[12px] text-amber-ink">
                  {t("ttsPanel.convertError", { error: convertError })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-line bg-surface p-3.5 shadow-paper-sm">
          <Waveform playing={playing} />

          {src && (
            <audio
              ref={audioRef}
              src={src}
              onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
              onEnded={() => {
                setPlaying(false);
                setPosition(0);
              }}
              className="hidden"
            />
          )}

          <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-3">
            <span>{formatDuration(position * 1000)}</span>
            <span>{total}</span>
          </div>

          {/* The play button is centred on the card, not on the row: the
              side controls are laid out around it rather than sharing the
              space with it. */}
          <div className="relative mt-2.5 flex items-center justify-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("ttsPanel.rewind")}
              className="text-ink-2"
              disabled={!src}
              onClick={() => skip(-SKIP_SECONDS)}
            >
              <Rewind />
            </Button>
            <button
              onClick={() => setPlaying(!playing)}
              disabled={!src}
              aria-label={t(playing ? "ttsPanel.pause" : "ttsPanel.play")}
              className="grid size-10 cursor-pointer place-items-center rounded-full bg-teal text-surface shadow-paper-sm transition-colors hover:bg-teal-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("ttsPanel.forward")}
              className="text-ink-2"
              disabled={!src}
              onClick={() => skip(SKIP_SECONDS)}
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
