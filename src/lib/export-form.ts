/**
 * The rules behind the Export dialog and progress view, kept pure so they are
 * tested: vitest only runs `src/**​/*.test.ts`, so nothing in a `.tsx` is.
 */
import type { ExportStatus, ProjectDetail, RunningExport } from "./api";

export type ExportForm = {
  voice: string;
  rate: number;
  wholeBook: boolean;
  first: number;
  last: number;
  /** Where the last export was saved, offered to the Save picker. */
  path: string | null;
};

type Defaults = Pick<
  ProjectDetail,
  | "pageCount"
  | "voice"
  | "rate"
  | "exportVoice"
  | "exportRate"
  | "exportFirstPage"
  | "exportLastPage"
  | "exportPath"
>;

export function clampPage(n: number, pageCount: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, Math.round(n)), Math.max(1, pageCount));
}

/**
 * The last export's settings, else the panel's voice and rate over the whole
 * book. Defaulting to the panel's is what makes existing takes likely to match
 * and be reused.
 */
export function exportDefaults(p: Defaults): ExportForm {
  let first = clampPage(p.exportFirstPage ?? 1, p.pageCount);
  let last = clampPage(p.exportLastPage ?? p.pageCount, p.pageCount);
  if (first > last) [first, last] = [1, p.pageCount];
  return {
    voice: p.exportVoice ?? p.voice ?? "",
    rate: p.exportRate ?? p.rate,
    wholeBook: first === 1 && last === p.pageCount,
    first,
    last,
    path: p.exportPath,
  };
}

export function rangeOf(form: ExportForm, pageCount: number): { first: number; last: number } {
  return form.wholeBook ? { first: 1, last: pageCount } : { first: form.first, last: form.last };
}

export function rangeIsValid(first: number, last: number, pageCount: number): boolean {
  return first >= 1 && last <= pageCount && first <= last;
}

/** `<title>.mp3`, with the characters Windows and macOS refuse replaced. */
export function defaultFileName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return `${safe || "audiobook"}.mp3`;
}

/** The GTK Save picker does not add the filter's extension; do it here. */
export function withMp3Extension(path: string): string {
  return /\.mp3$/i.test(path) ? path : `${path}.mp3`;
}

/**
 * About how long is left: this run's mean seconds per page times the pages
 * left. Null before three pages, when a mean is mostly noise.
 */
export function timeLeftMs(elapsedMs: number, finished: number, remaining: number): number | null {
  if (finished < 3 || remaining <= 0) return null;
  return Math.round((elapsedMs / finished) * remaining);
}

/** How full the overall bar is, 0-1. */
export function overallFraction(s: RunningExport): number {
  if (s.phase === "stitching") return s.pageProgress;
  if (s.total === 0) return 0;
  return Math.min(1, (s.done + s.pageProgress) / s.total);
}

/**
 * `m:ss`, or `h:mm:ss` from an hour up. Unlike the player's `formatDuration`,
 * minutes carry into hours: an audiobook runs for hours, not minutes.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export type PillLabel =
  | { kind: "running"; percent: number }
  | { kind: "ready" }
  | { kind: "attention" };

/**
 * What the title-bar pill shows, or null for no pill. A cancelled run shows
 * none: the user just asked for it.
 */
export function pillLabel(status: ExportStatus | null): PillLabel | null {
  if (!status) return null;
  if (status.state === "running") {
    return { kind: "running", percent: Math.round(overallFraction(status) * 100) };
  }
  switch (status.outcome.kind) {
    case "done":
      return { kind: "ready" };
    case "failed":
    case "error":
      return { kind: "attention" };
    case "cancelled":
      return null;
  }
}
