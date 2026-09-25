import { describe, expect, it } from "vitest";
import {
  canDelete,
  canImportFromFolder,
  formatBytes,
  installLocked,
  installedFraction,
  languageState,
  modelStateFor,
  primaryAction,
  type ModelsSnapshot,
} from "./model-state";
import type { ModelStatus } from "./api";

const base = {
  present: false,
  partialBytes: 0,
  engineUp: false,
  installing: false,
  error: null as string | null,
};

describe("modelStateFor", () => {
  it("offers a download for a language with nothing on disk", () => {
    expect(modelStateFor(base)).toBe("missing");
  });

  it("distinguishes a resumable download from a fresh one", () => {
    // The button promises something different: resume, not start.
    expect(modelStateFor({ ...base, partialBytes: 4096 })).toBe("partial");
  });

  it("is ready when the files verify and the engine came up", () => {
    expect(modelStateFor({ ...base, present: true, engineUp: true })).toBe("ready");
  });

  it("does not call a model ready when its engine failed to load", () => {
    // Collapsing this into "ready" leaves the panel claiming the language is
    // installed while every Convert fails, with nothing to act on.
    expect(modelStateFor({ ...base, present: true, engineUp: false })).toBe("unloadable");
  });

  it("shows an install in flight above everything else", () => {
    expect(
      modelStateFor({ ...base, installing: true, error: "boom", present: true, engineUp: true }),
    ).toBe("installing");
  });

  it("shows a failure above the partial download it left behind", () => {
    // The bytes on disk are usually the wreckage of the failure. Showing
    // "resume" instead of the reason hides why it stopped.
    expect(modelStateFor({ ...base, error: "checksum", partialBytes: 4096 })).toBe("error");
  });

  it("treats a cleared error as no error", () => {
    // A cancellation is not a failure; the caller clears it to null.
    expect(modelStateFor({ ...base, error: null, partialBytes: 4096 })).toBe("partial");
  });
});

describe("formatBytes", () => {
  it("reads a model size the way a download would", () => {
    expect(formatBytes(114_029_960)).toBe("114 MB");
    expect(formatBytes(329_191_409)).toBe("329 MB");
  });

  it("switches to gigabytes once megabytes stop being readable", () => {
    expect(formatBytes(1_400_000_000)).toBe("1.4 GB");
  });
});

describe("installedFraction", () => {
  it("counts partial bytes, so a resumed download does not start the bar at zero", () => {
    expect(
      installedFraction({ bytes: 100, installedBytes: 0, partialBytes: 25 }),
    ).toBe(0.25);
  });

  it("counts installed files too, for a language part-way through its manifest", () => {
    expect(
      installedFraction({ bytes: 100, installedBytes: 60, partialBytes: 20 }),
    ).toBe(0.8);
  });

  it("never exceeds one", () => {
    expect(
      installedFraction({ bytes: 100, installedBytes: 100, partialBytes: 50 }),
    ).toBe(1);
  });

  it("is zero for a language with no manifest size", () => {
    expect(installedFraction({ bytes: 0, installedBytes: 0, partialBytes: 0 })).toBe(0);
  });
});

const row = (over: Partial<ModelStatus> = {}): ModelStatus => ({
  language: "am",
  present: false,
  bytes: 114_000_000,
  installedBytes: 0,
  partialBytes: 0,
  ...over,
});

const snap = (over: Partial<ModelsSnapshot> = {}): ModelsSnapshot => ({
  rows: [row()],
  engines: {},
  installing: null,
  error: null,
  ...over,
});

describe("primaryAction", () => {
  it("names the button each resting state offers", () => {
    expect(primaryAction("missing")).toBe("download");
    expect(primaryAction("partial")).toBe("resume");
    expect(primaryAction("error")).toBe("retry");
    expect(primaryAction("unloadable")).toBe("reinstall");
  });

  it("offers nothing while installing or once ready", () => {
    expect(primaryAction("installing")).toBeNull();
    expect(primaryAction("ready")).toBeNull();
  });
});

describe("languageState", () => {
  it("reads a language's row and engine", () => {
    const s = snap({ rows: [row({ present: true, installedBytes: 114_000_000 })], engines: { am: true } });
    expect(languageState(s, "am")).toBe("ready");
  });

  it("trusts the files while engine health is unknown", () => {
    const s = snap({ rows: [row({ present: true })], engines: null });
    expect(languageState(s, "am")).toBe("ready");
  });

  it("shows an install only for the language being installed", () => {
    expect(languageState(snap({ installing: "am" }), "am")).toBe("installing");
    expect(languageState(snap({ installing: "ti" }), "am")).toBe("missing");
  });

  it("shows an error only for the language it belongs to", () => {
    const error = { language: "ti", message: "checksum" };
    expect(languageState(snap({ error }), "am")).toBe("missing");
    expect(languageState(snap({ rows: [row({ language: "ti" })], error }), "ti")).toBe("error");
  });
});

describe("canDelete", () => {
  it("allows deleting anything on disk, finished or partial", () => {
    expect(canDelete(row({ installedBytes: 10 }), "ready")).toBe(true);
    expect(canDelete(row({ partialBytes: 10 }), "partial")).toBe(true);
    expect(canDelete(row({ installedBytes: 10 }), "unloadable")).toBe(true);
  });

  it("offers nothing to delete when nothing is there", () => {
    expect(canDelete(row(), "missing")).toBe(false);
    expect(canDelete(null, "missing")).toBe(false);
  });

  it("never deletes out from under an install", () => {
    expect(canDelete(row({ partialBytes: 10 }), "installing")).toBe(false);
  });
});

describe("canImportFromFolder", () => {
  it("offers a folder install wherever there is something to install", () => {
    for (const s of ["missing", "partial", "error", "unloadable"] as const) {
      expect(canImportFromFolder(s)).toBe(true);
    }
  });

  it("hides it once ready, and while an install is running", () => {
    expect(canImportFromFolder("ready")).toBe(false);
    expect(canImportFromFolder("installing")).toBe(false);
  });
});

describe("installLocked", () => {
  it("locks every language's install buttons while any install runs", () => {
    expect(installLocked({ language: "am" })).toBe(true);
  });

  it("leaves them free when nothing is installing", () => {
    expect(installLocked(null)).toBe(false);
  });
});
