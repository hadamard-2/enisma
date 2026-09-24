import { describe, expect, it } from "vitest";
import {
  defaultFileName,
  exportDefaults,
  formatClock,
  overallFraction,
  pillLabel,
  pagesOf,
  parsePages,
  timeLeftMs,
  withMp3Extension,
} from "./export-form";
import type { RunningExport } from "./api";

const project = {
  title: "Biology 9",
  pageCount: 171,
  voice: "af_heart",
  rate: 1.1,
  exportVoice: null,
  exportRate: null,
  exportPath: null,
};

const running = (over: Partial<RunningExport> = {}): RunningExport => ({
  state: "running",
  projectId: "p1",
  title: "Biology",
  phase: "synthesizing",
  done: 0,
  total: 10,
  pageNo: 1,
  pageProgress: 0,
  synthesized: 0,
  startedAtMs: 0,
  ...over,
});

describe("exportDefaults", () => {
  it("falls back to the panel's voice and rate and the whole book", () => {
    expect(exportDefaults(project)).toEqual({
      voice: "af_heart",
      rate: 1.1,
      wholeBook: true,
      pagesText: "",
      path: null,
    });
  });

  it("prefers the last export's voice and rate but starts on the whole book", () => {
    const d = exportDefaults({
      ...project,
      exportVoice: "am_adam",
      exportRate: 0.9,
      exportPath: "/home/u/b.mp3",
    });
    expect(d).toEqual({
      voice: "am_adam",
      rate: 0.9,
      wholeBook: true,
      pagesText: "",
      path: "/home/u/b.mp3",
    });
  });

  it("uses an empty voice when nothing was ever chosen", () => {
    expect(exportDefaults({ ...project, voice: null }).voice).toBe("");
  });
});

describe("pages", () => {
  it("parses ranges and single pages into sorted, distinct pages", () => {
    expect(parsePages("1-3, 9, 5", 10)).toEqual([1, 2, 3, 5, 9]);
    expect(parsePages("8-10 2 9", 10)).toEqual([2, 8, 9, 10]);
    expect(parsePages("4–2", 10)).toEqual([2, 3, 4]);
    expect(parsePages(" 3 , 3,", 10)).toEqual([3]);
  });

  it("rejects an empty, malformed or out-of-book list", () => {
    expect(parsePages("", 10)).toBeNull();
    expect(parsePages(" , ", 10)).toBeNull();
    expect(parsePages("1-", 10)).toBeNull();
    expect(parsePages("a", 10)).toBeNull();
    expect(parsePages("0-2", 10)).toBeNull();
    expect(parsePages("9-11", 10)).toBeNull();
  });

  it("resolves the whole book or the typed pages", () => {
    const form = { voice: "", rate: 1, wholeBook: true, pagesText: "3-4", path: null };
    expect(pagesOf(form, 4)).toEqual([1, 2, 3, 4]);
    expect(pagesOf({ ...form, wholeBook: false }, 9)).toEqual([3, 4]);
  });
});

describe("file names", () => {
  it("names the file after the book, without characters a file system refuses", () => {
    expect(defaultFileName("Biology 9")).toBe("Biology 9.mp3");
    expect(defaultFileName('Grade 9: "Cells" / Part 1')).toBe("Grade 9- -Cells- - Part 1.mp3");
    expect(defaultFileName("ባዮሎጂ")).toBe("ባዮሎጂ.mp3");
    expect(defaultFileName("   ")).toBe("audiobook.mp3");
  });

  it("adds .mp3 only when it is missing", () => {
    expect(withMp3Extension("/a/b")).toBe("/a/b.mp3");
    expect(withMp3Extension("/a/b.mp3")).toBe("/a/b.mp3");
    expect(withMp3Extension("/a/b.MP3")).toBe("/a/b.MP3");
  });
});

describe("timeLeftMs", () => {
  it("offers no estimate before three pages have finished", () => {
    expect(timeLeftMs(60_000, 2, 10)).toBeNull();
  });

  it("is the run's mean page time times the pages left", () => {
    expect(timeLeftMs(90_000, 3, 10)).toBe(300_000);
  });

  it("offers nothing once nothing is left", () => {
    expect(timeLeftMs(90_000, 3, 0)).toBeNull();
  });
});

describe("overallFraction", () => {
  it("counts finished pages plus the current page's share", () => {
    expect(overallFraction(running({ done: 2, total: 10, pageProgress: 0.5 }))).toBeCloseTo(0.25);
  });

  it("follows the stitch while stitching", () => {
    expect(overallFraction(running({ phase: "stitching", pageProgress: 0.4 }))).toBeCloseTo(0.4);
  });

  it("is zero before the first page", () => {
    expect(overallFraction(running({ total: 0 }))).toBe(0);
  });
});

describe("formatClock", () => {
  it("carries minutes into hours for book-length times", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_723_000)).toBe("1:02:03");
  });
});

describe("pillLabel", () => {
  it("shows progress while running and a result afterwards", () => {
    expect(pillLabel(null)).toBeNull();
    expect(pillLabel(running({ done: 1, total: 4 }))).toEqual({ kind: "running", percent: 25 });
    const finished = (outcome: object) =>
      ({ state: "finished", projectId: "p1", title: "t", outcome }) as never;
    expect(pillLabel(finished({ kind: "done", path: "", durationMs: 0, empty: [] }))).toEqual({
      kind: "ready",
    });
    expect(pillLabel(finished({ kind: "failed", pages: [], empty: [] }))).toEqual({
      kind: "attention",
    });
    expect(pillLabel(finished({ kind: "error", message: "" }))).toEqual({ kind: "attention" });
    expect(pillLabel(finished({ kind: "cancelled", kept: 0 }))).toBeNull();
  });
});
