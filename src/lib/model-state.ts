import type { ModelStatus } from "./api";

/**
 * What the voice-model half of the settings panel should be showing.
 *
 * Acquisition is explicit and never automatic: the models run to hundreds of
 * megabytes and the user may be paying for the bandwidth, so nothing is
 * fetched until they ask. That makes this a resting-state question — what does
 * this language have, and what can be done about it — rather than a progress
 * question.
 *
 * "present" and "ready" are deliberately not the same state. Files can verify
 * and the engine still fail to load, and collapsing the two would leave the
 * panel saying "installed" over a language that cannot speak, with no way for
 * the user to tell why Convert keeps failing.
 */
export type ModelPanelState =
  | "installing"
  | "error"
  | "missing"
  | "partial"
  | "unloadable"
  | "ready";

export function modelStateFor(state: {
  /** Every file present and hash-verified. */
  present: boolean;
  /** Bytes an interrupted download left behind, resumable on the next try. */
  partialBytes: number;
  /** Whether the sidecar actually has an engine for this language. */
  engineUp: boolean;
  /** Whether an install is in flight for this language right now. */
  installing: boolean;
  /**
   * The untranslated message from an install that failed, or null. A
   * cancellation is not a failure and must be cleared to null by the caller.
   */
  error?: string | null;
}): ModelPanelState {
  const { present, partialBytes, engineUp, installing, error = null } = state;

  // An install in flight outranks everything, including the message from the
  // earlier attempt this one is retrying.
  if (installing) return "installing";

  // A failure is the outcome of something the user asked for and watched for
  // minutes. It outranks every resting state, including a partial download —
  // which is what a failure usually leaves behind, and which would otherwise
  // replace the reason with a bare "resume".
  if (error !== null) return "error";

  // Files verified but no engine: a real load failure the user cannot diagnose
  // from "installed". Reinstalling is the only thing they can usefully try.
  if (present) return engineUp ? "ready" : "unloadable";

  // Bytes on disk mean the next attempt resumes rather than starting over,
  // which changes what the button should promise.
  return partialBytes > 0 ? "partial" : "missing";
}

/**
 * A byte count as the user would read it on a download.
 *
 * Decimal megabytes, not mebibytes: these figures are compared against a data
 * bundle and a browser's download UI, both of which count in millions.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/**
 * How far through installing this language we are, as a fraction.
 *
 * Prefers live progress from the running job, and falls back to what is
 * already on disk — so a panel opened onto a half-finished download shows the
 * bar part-filled instead of at zero before the first event arrives.
 */
export function installedFraction(status: {
  bytes: number;
  installedBytes: number;
  partialBytes: number;
}): number {
  if (status.bytes <= 0) return 0;
  const have = status.installedBytes + status.partialBytes;
  return Math.min(1, Math.max(0, have / status.bytes));
}

/** The one button a language's resting state offers. */
export type PrimaryAction = "download" | "resume" | "retry" | "reinstall";

/**
 * Which button a state offers, shared by the editor's panel and Settings so
 * the same state is never labelled two ways. None while installing, and none
 * once the language is ready.
 */
export function primaryAction(state: ModelPanelState): PrimaryAction | null {
  switch (state) {
    case "missing":
      return "download";
    case "partial":
      return "resume";
    case "error":
      return "retry";
    case "unloadable":
      return "reinstall";
    default:
      return null;
  }
}

/** Everything the app knows about voice models at one moment. */
export interface ModelsSnapshot {
  /** From `modelStatus()`; null while the sidecar has not answered. */
  rows: ModelStatus[] | null;
  /** From `sidecarHealth().engines`; null while unknown. */
  engines: Record<string, unknown> | null;
  /** The language an install is running for, if any. */
  installing: string | null;
  /** The last failed install and the language it belongs to. */
  error: { language: string; message: string } | null;
}

/**
 * One language's state from the app-wide snapshot.
 *
 * With engine health unknown the files are trusted, rather than accusing a
 * working model of failing to load; a conversion would surface the truth.
 */
export function languageState(s: ModelsSnapshot, language: string): ModelPanelState {
  const row = s.rows?.find((r) => r.language === language) ?? null;
  const present = row?.present ?? false;
  return modelStateFor({
    present,
    partialBytes: row?.partialBytes ?? 0,
    engineUp: s.engines === null ? present : Boolean(s.engines[language]),
    installing: s.installing === language,
    error: s.error?.language === language ? s.error.message : null,
  });
}

/**
 * Whether a language has anything to delete. Partial downloads count, so
 * abandoned scratch files can be cleared too; an install in flight never.
 */
export function canDelete(row: ModelStatus | null, state: ModelPanelState): boolean {
  if (row === null || state === "installing") return false;
  return row.installedBytes + row.partialBytes > 0;
}

/**
 * Whether a language's row offers "Install from folder". Hidden once ready
 * (nothing to install) and while installing; everywhere else it doubles as
 * the offline Download, Resume, Retry or Reinstall.
 */
export function canImportFromFolder(state: ModelPanelState): boolean {
  return state !== "ready" && state !== "installing";
}

/**
 * Whether every language's install buttons are disabled. One install at a
 * time, app-wide: the backend has a single slot for it.
 */
export function installLocked(install: { language: string } | null): boolean {
  return install !== null;
}
