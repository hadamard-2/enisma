import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { AudioLines, Pause, Play, RotateCcw, RotateCw, SkipBack, SkipForward } from "lucide-react";
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
import { LANGUAGES, languageLabelKey } from "@/lib/languages";
import { audioStateFor, formatDuration } from "@/lib/audio-state";
import {
  decodeWav,
  placeholderPeaks,
  resampleBars,
  WAVE_RESOLUTION,
  wavePeaks,
  type DecodedWav,
} from "@/lib/waveform";
import type { ModelPanelState } from "@/lib/model-state";
import type { ModelStatus, PageAudio } from "@/lib/api";
import { ModelPanel } from "./model-panel";
import { Field, KokoroVoiceName, LabeledSlider, SingleSpeakerVoice } from "./voice-fields";

/** How far the back and forward buttons jump, in seconds. */
const SKIP_SECONDS = 5;
/**
 * The waveform is a fixed shape: this many bars, this wide, this far apart,
 * centred in the card. A wider panel only adds space either side of it.
 */
const WAVE_BAR_COUNT = 70;
const BAR_PX = 3;
const GAP_PX = 2;
/** How far an arrow key on the waveform jumps, in seconds. */
const KEY_SEEK_SECONDS = 5;



type Take = {
  /** The decoded samples, or null until loaded (or if they could not be). */
  wav: DecodedWav | null;
  /** Measured bar heights, or null if the file could not be read for them. */
  peaks: number[] | null;
  /** Why the take could not be loaded; untranslated. */
  error: string | null;
};

/**
 * Load a stored take into memory, for playback and for its waveform.
 *
 * Fetched and decoded here, then played through Web Audio — never handed to an
 * <audio> element. WebKitGTK, the webview on Linux, refuses Tauri's `asset:`
 * scheme as a media source outright, and given a `blob:` URL instead it plays
 * the first time but misplaces every seek: measured from the speaker output,
 * "go to start" reported position 0 while sounding from 87s into the page. A
 * `fetch` of the asset URL is reliable (it is how pdf.js loads the book), and
 * holding the samples makes seeking exact.
 *
 * `createdAt` is in the key because a re-conversion writes new bytes to the
 * same path, one take per page by design. The query string makes each take's
 * URL distinct for any cache in between; the asset protocol resolves the path
 * only, so the query does not change what is read.
 */
function useTake(path: string | null, createdAt: number | null): Take {
  const [take, setTake] = useState<Take>({ wav: null, peaks: null, error: null });

  useEffect(() => {
    setTake({ wav: null, peaks: null, error: null });
    if (!path) return;
    let cancelled = false;
    const abort = new AbortController();
    fetch(`${convertFileSrc(path)}?v=${createdAt ?? 0}`, {
      cache: "no-store",
      signal: abort.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const wav = decodeWav(buf);
        if (!wav) throw new Error("not a WAV file Enisma can play");
        setTake({ wav, peaks: wavePeaks(buf, WAVE_RESOLUTION), error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error(e);
        setTake({ wav: null, peaks: null, error: String(e) });
      });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [path, createdAt]);

  return take;
}

/**
 * A transport over decoded samples: play, pause, and exact seeking.
 *
 * Web Audio has no pausable, seekable source — an AudioBufferSourceNode plays
 * once from an offset and is thrown away — so the position is the model here:
 * pausing records it, and playing or seeking starts a fresh source there. The
 * displayed position is read from the audio clock every frame while playing,
 * so it moves smoothly rather than in the media element's ~0.27s steps.
 */
function usePlayer(
  wav: DecodedWav | null,
  playing: boolean,
  setPlaying: (p: boolean) => void,
  onError: (message: string) => void,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Where playback is, as of `startedAt` on the audio clock (null while paused).
  const offsetRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  const duration = wav ? wav.frames / wav.sampleRate : 0;
  // Read by the resume continuation: a pause pressed while the audio context
  // was still waking up must win, or the sound would start after it.
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const now = useCallback(() => {
    const ctx = ctxRef.current;
    const started = startedAtRef.current;
    if (!ctx || started === null) return offsetRef.current;
    return Math.min(duration, offsetRef.current + (ctx.currentTime - started));
  }, [duration]);

  const halt = useCallback(() => {
    const src = sourceRef.current;
    sourceRef.current = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      src.disconnect();
    }
  }, []);

  const startAt = useCallback(
    (offset: number) => {
      const ctx = ctxRef.current;
      const buffer = bufferRef.current;
      if (!ctx || !buffer) return;
      halt();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        // Only a source that ran out, not one we replaced or stopped.
        if (sourceRef.current !== src) return;
        sourceRef.current = null;
        startedAtRef.current = null;
        offsetRef.current = duration;
        setPosition(duration);
        setPlaying(false);
      };
      offsetRef.current = offset;
      startedAtRef.current = ctx.currentTime;
      src.start(0, offset);
      sourceRef.current = src;
    },
    [duration, halt, setPlaying],
  );

  // A new take starts from the beginning and never leaves the previous one
  // sounding behind the new label.
  useEffect(() => {
    halt();
    startedAtRef.current = null;
    offsetRef.current = 0;
    bufferRef.current = null;
    setPosition(0);
    setPlaying(false);
  }, [wav, halt, setPlaying]);

  useEffect(() => {
    if (!wav) return;
    if (!playing) {
      if (startedAtRef.current !== null) {
        offsetRef.current = now();
        startedAtRef.current = null;
        setPosition(offsetRef.current);
      }
      halt();
      return;
    }
    if (sourceRef.current) return;
    // Created on first play, inside the click that asked for it, which is
    // what lets the webview allow sound at all.
    ctxRef.current ??= new AudioContext();
    const ctx = ctxRef.current;
    if (!bufferRef.current) {
      const b = ctx.createBuffer(wav.channels.length, wav.frames, wav.sampleRate);
      wav.channels.forEach((ch, i) => b.copyToChannel(ch, i));
      bufferRef.current = b;
    }
    // Play from the end means play again from the start.
    const from = offsetRef.current >= duration - 0.05 ? 0 : offsetRef.current;
    ctx.resume().then(
      () => {
        if (playingRef.current && !sourceRef.current) startAt(from);
      },
      (e: unknown) => {
        setPlaying(false);
        onError(String(e));
      },
    );
  }, [playing, wav, duration, halt, now, startAt, setPlaying, onError]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      setPosition(now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, now]);

  useEffect(
    () => () => {
      halt();
      void ctxRef.current?.close();
      ctxRef.current = null;
    },
    [halt],
  );

  const seek = useCallback(
    (seconds: number) => {
      const to = Math.min(Math.max(0, seconds), duration);
      setPosition(to);
      if (sourceRef.current) startAt(to);
      else offsetRef.current = to;
    },
    [duration, startAt],
  );

  return { position, duration, seek, now };
}

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
  convertingPage,
  cancelling,
  progress,
  convertError,
  onConvert,
  onCancel,
  model,
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
  /**
   * The page being converted, or null. Not necessarily `page`: other pages
   * stay open for reading and editing while one converts, but only one
   * conversion runs at a time.
   */
  convertingPage: number | null;
  /** A stop has been requested but the conversion has not settled yet. */
  cancelling: boolean;
  /** Fraction 0-1 from the last `tts://progress` event. */
  progress: number;
  /** Untranslated message from a conversion that failed, or null. */
  convertError: string | null;
  onConvert: () => void;
  onCancel: () => void;
  /**
   * This language's voice model, and what can be done about it. Travels as one
   * object rather than eight props because the panel only ever asks one
   * question of it: is there a usable voice, and if not, what now.
   */
  model: {
    state: ModelPanelState;
    status: ModelStatus | null;
    progress: number;
    error: string | null;
    cancelling: boolean;
    onDownload: () => void;
    onImport: () => void;
    onCancel: () => void;
  };
}) {
  const { t } = useTranslation();
  const converting = convertingPage !== null;

  const state = audioStateFor({
    path: audio?.path ?? null,
    stale: audio?.stale ?? true,
    converting: convertingPage === page,
    hasText,
    error: convertError,
  });

  const take = useTake(audio?.path ?? null, audio?.createdAt ?? null);
  /** Why playback was refused; untranslated. Shown rather than swallowed. */
  const [playError, setPlayError] = useState<string | null>(null);
  useEffect(() => setPlayError(null), [take.wav]);
  const player = usePlayer(take.wav, playing, setPlaying, setPlayError);
  const ready = take.wav !== null;
  const position = player.position;
  // The stored duration stands in until the take has loaded.
  const durationSeconds = ready ? player.duration : (audio?.durationMs ?? 0) / 1000;
  const seek = player.seek;

  function skip(seconds: number) {
    seek(player.now() + seconds);
  }

  // A page with no take yet still gets a wave, invented and seeded by page
  // number so it holds still. It is replaced by the real one once a take
  // exists — including a stale take, which is still this page's audio.
  const invented = useMemo(() => placeholderPeaks(page, WAVE_RESOLUTION), [page]);
  const peaks = take.peaks ?? invented;
  const loadError = take.error ?? playError;

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
        {voices.length > 0 ? (
          <Field label={t("ttsPanel.voice")}>
            <Select value={voice} onValueChange={setVoice} disabled={converting}>
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
          <SingleSpeakerVoice language={language} />
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
            costs 40-100 seconds — so this is the panel's loudest control.

            A language with no usable voice takes this slot instead of sitting
            beside it: the user came here to hear the page, and installing the
            model is simply the first half of that. A disabled Convert with the
            reason elsewhere would leave them hunting for it. */}
        <div className="mb-3">
          {model.state !== "ready" ? (
            <ModelPanel
              state={model.state}
              languageLabel={t(languageLabelKey(language))}
              status={model.status}
              progress={model.progress}
              error={model.error}
              cancelling={model.cancelling}
              onDownload={model.onDownload}
              onImport={model.onImport}
              onCancel={model.onCancel}
            />
          ) : converting ? (
            <div className="rounded-xl border border-line bg-surface p-3.5 shadow-paper-sm">
              <div className="flex items-center gap-2 text-[13px] text-ink-2">
                <AudioLines size={15} className="animate-pulse text-teal" />
                {t("ttsPanel.converting", { n: convertingPage ?? page })}
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
          {/* Sized to the wave, so the two times sit under its first and last
              bars rather than at the card's edges. */}
          <div className="mx-auto w-fit max-w-full">
            <Waveform
              peaks={peaks}
              position={position}
              duration={durationSeconds}
              onSeek={ready ? seek : undefined}
              label={t("ttsPanel.position")}
            />

            <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-3">
              <span>{formatDuration(position * 1000)}</span>
              <span>{total}</span>
            </div>
          </div>

          {/* The play button is centred on the card, not on the row: the
              side controls are laid out around it rather than sharing the
              space with it. */}
          <div className="relative mt-2.5 flex items-center justify-center gap-1.5">
            <Control label={t("ttsPanel.toStart")} disabled={!ready} onClick={() => seek(0)}>
              <SkipBack />
            </Control>
            <Control
              label={t("ttsPanel.back", { seconds: SKIP_SECONDS })}
              disabled={!ready}
              onClick={() => skip(-SKIP_SECONDS)}
            >
              <RotateCcw />
            </Control>
            <button
              onClick={() => setPlaying(!playing)}
              disabled={!ready}
              aria-label={t(playing ? "ttsPanel.pause" : "ttsPanel.play")}
              className="mx-1 grid size-10 cursor-pointer place-items-center rounded-full bg-teal text-surface shadow-paper-sm transition-colors hover:bg-teal-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              {playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
            </button>
            <Control
              label={t("ttsPanel.forward", { seconds: SKIP_SECONDS })}
              disabled={!ready}
              onClick={() => skip(SKIP_SECONDS)}
            >
              <RotateCw />
            </Control>
            <Control label={t("ttsPanel.toEnd")} disabled={!ready} onClick={() => seek(durationSeconds)}>
              <SkipForward />
            </Control>
          </div>

          {/* The engine's own words, deliberately untranslated. */}
          {loadError !== null && (
            <div className="mt-2.5 text-[12px] text-amber-ink">
              {t("ttsPanel.audioLoadError", { error: loadError })}
            </div>
          )}
        </div>

      </div>
      </div>

    </aside>
  );
}

/** A secondary transport button, with its label as tooltip and for screen readers. */
function Control({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className="text-ink-2"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * Voice-message style waveform: thin rounded bars mirrored about the centre
 * line, filled up to the playhead, and clickable to jump.
 *
 * A fixed number of fixed-width bars, centred: resizing the panel changes
 * only the space around the wave, never the bars themselves.
 */
function Waveform({
  peaks,
  position,
  duration,
  onSeek,
  label,
}: {
  /** Fine-grained levels, 0-1, grouped into WAVE_BAR_COUNT bars. */
  peaks: number[];
  /** Seconds. */
  position: number;
  /** Seconds; 0 while unknown. */
  duration: number;
  /** Absent while there is nothing to seek in. */
  onSeek?: (seconds: number) => void;
  label: string;
}) {
  const bars = useMemo(() => resampleBars(peaks, WAVE_BAR_COUNT), [peaks]);

  const played = duration > 0 ? position / duration : 0;
  const seekable = onSeek !== undefined && duration > 0;

  function seekTo(e: PointerEvent<HTMLDivElement>) {
    if (!seekable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(fraction * duration);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!seekable) return;
    if (e.key === "ArrowLeft") onSeek(position - KEY_SEEK_SECONDS);
    else if (e.key === "ArrowRight") onSeek(position + KEY_SEEK_SECONDS);
    else return;
    e.preventDefault();
  }

  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(position)}
      aria-valuetext={formatDuration(position * 1000)}
      aria-disabled={!seekable}
      tabIndex={seekable ? 0 : -1}
      onPointerDown={seekTo}
      onKeyDown={onKeyDown}
      // An explicit width, not the content's: sized by its content inside the
      // fit-to-wave wrapper, the row collapsed to its minimum and every bar
      // rendered 1px wide. `max-w-full` still lets it shrink in a narrow card.
      style={{ width: WAVE_BAR_COUNT * BAR_PX + (WAVE_BAR_COUNT - 1) * GAP_PX }}
      className={cn(
        "mt-0.5 flex h-8 max-w-full items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-teal/40",
        seekable && "cursor-pointer",
      )}
    >
      {bars.map((h, i) => (
        <div
          key={i}
          className={cn(
            // Shrinks only if the card is narrower than the whole wave;
            // otherwise every bar keeps its width.
            "min-w-px rounded-full transition-colors duration-150",
            i / bars.length < played ? "bg-teal" : "bg-line-2",
          )}
          // A floor, so the quietest bar still reads as part of the wave
          // rather than a gap in it.
          style={{
            flex: `0 1 ${BAR_PX}px`,
            marginLeft: i === 0 ? 0 : GAP_PX,
            height: `${Math.round(12 + 88 * h)}%`,
          }}
        />
      ))}
    </div>
  );
}
