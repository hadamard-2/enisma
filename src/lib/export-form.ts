/**
 * The rules behind the Export dialog and progress view, kept pure so they are
 * tested: vitest only runs `src/**​/*.test.ts`, so nothing in a `.tsx` is.
 */
import type { ExportStatus, ProjectDetail, RunningExport } from "./api";

export type ExportForm = {
  voice: string;
  rate: number;
  wholeBook: boolean;
  /** The typed page list, e.g. `1-5, 9, 12-20`. */
  pagesText: string;
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
  | "exportPath"
>;

/**
 * The last export's voice and rate, else the panel's, over the whole book.
 * Defaulting to the panel's is what makes existing takes likely to match and
 * be reused. The pages are not remembered.
 */
export function exportDefaults(p: Defaults): ExportForm {
  return {
    voice: p.exportVoice ?? p.voice ?? "",
    rate: p.exportRate ?? p.rate,
    wholeBook: true,
    pagesText: "",
    path: p.exportPath,
  };
}

/**
 * Parse a page list like `1-5, 9, 12-20` into ascending, distinct page
 * numbers. Commas or spaces separate items; a range may be written either way
 * round. Null when anything is malformed, outside the book, or nothing is left.
 */
export function parsePages(text: string, pageCount: number): number[] | null {
  const items = text.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return null;
  const pages = new Set<number>();
  for (const item of items) {
    const m = /^(\d+)(?:[-–—](\d+))?$/.exec(item);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (lo < 1 || hi > pageCount) return null;
    for (let n = lo; n <= hi; n++) pages.add(n);
  }
  return [...pages].sort((x, y) => x - y);
}

/** The pages an export covers, or null when the typed list is not usable. */
export function pagesOf(form: ExportForm, pageCount: number): number[] | null {
  if (form.wholeBook) return Array.from({ length: pageCount }, (_, i) => i + 1);
  return parsePages(form.pagesText, pageCount);
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
