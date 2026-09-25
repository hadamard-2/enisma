import { invoke } from "@tauri-apps/api/core";
import type { LanguageCode } from "./languages";

export interface ProjectSummary {
  id: string;
  title: string;
  language: LanguageCode;
  pageCount: number;
  pagesReviewed: number;
  status: "new" | "in-progress" | "done";
  updatedAt: string;
}

export interface PageMeta {
  pageNo: number;
  done: boolean;
}

export interface ProjectDetail {
  id: string;
  title: string;
  language: LanguageCode;
  pageCount: number;
  /** Absolute path, already resolved by Rust; feed to convertFileSrc. */
  pdfPath: string;
  rate: number;
  /** Right-hand panel's remembered voice, not a book property; the default M5's export offers. */
  voice: string | null;
  /** The page this project was last left on; null if never. May exceed the page count. */
  lastPage: number | null;
  pages: PageMeta[];
  /** Pages never extracted (`source_text IS NULL`). Non-zero triggers repair. */
  pagesMissingText: number;
  /** The last export's settings, offered again by the Export dialog; null if never exported. */
  exportVoice: string | null;
  exportRate: number | null;
  /** Absolute path the last export was saved to. */
  exportPath: string | null;
}

export interface PageText {
  sourceText: string | null;
  editedText: string | null;
}

export const listProjects = () => invoke<ProjectSummary[]>("list_projects_cmd");

export const getProject = (id: string) => invoke<ProjectDetail>("get_project_cmd", { id });

export const importProject = (
  title: string,
  language: string,
  srcPath: string,
  pageTexts: string[],
) => invoke<string>("import_project_cmd", { title, language, srcPath, pageTexts });

export const updateProject = (
  id: string,
  patch: { title?: string; language?: string; rate?: number; voice?: string },
) => invoke<void>("update_project_cmd", { id, ...patch });

/** Delete a project, its pages, and the PDF copy made for it. Irreversible. */
export const deleteProject = (id: string) => invoke<void>("delete_project_cmd", { id });

export const getPage = (projectId: string, pageNo: number) =>
  invoke<PageText>("get_page_cmd", { projectId, pageNo });

export const savePageText = (projectId: string, pageNo: number, text: string) =>
  invoke<void>("save_page_text_cmd", { projectId, pageNo, text });

export const setPageDone = (projectId: string, pageNo: number, done: boolean) =>
  invoke<void>("set_page_done_cmd", { projectId, pageNo, done });

/** Every page's text as the editor shows it (the edit, else the extraction). */
export const listPageTexts = (projectId: string) =>
  invoke<{ pageNo: number; text: string }[]>("list_page_texts_cmd", { projectId });

/** Remember the page a project was left on. Does not count as an edit. */
export const setLastPage = (id: string, pageNo: number) =>
  invoke<void>("set_last_page_cmd", { id, pageNo });

export const savePageSourceText = (projectId: string, pageTexts: string[]) =>
  invoke<void>("save_page_source_text_cmd", { projectId, pageTexts });

/**
 * Read a picked PDF's bytes for extraction.
 *
 * The command returns a raw IPC response, which arrives as an ArrayBuffer.
 * The array fallback keeps this working if it ever arrives JSON-encoded.
 */
export const readPdfBytes = async (path: string): Promise<Uint8Array> => {
  const bytes = await invoke<ArrayBuffer | number[]>("read_pdf_bytes_cmd", { path });
  return new Uint8Array(bytes);
};

export interface PageAudio {
  /** Absolute path, already resolved by Rust; feed to convertFileSrc. */
  path: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  /**
   * When this take was recorded, epoch milliseconds, or null when there is no
   * take. The audio path is deterministic per page, so this is what tells one
   * take from the take that replaced it.
   */
  createdAt: number | null;
  /** No take, or one that no longer matches the text, language, voice and rate. */
  stale: boolean;
}

/** What `convertPage` rejects with when the conversion was actually stopped. */
export const CONVERSION_CANCELLED = "conversion cancelled";

/**
 * Synthesize one page. Slow — 40-100s — and resolves only when the job reaches
 * a terminal state. Progress arrives meanwhile on the `tts://progress` event.
 *
 * Three rejections matter to the caller, and all three arrive as a plain
 * English string: exactly `CONVERSION_CANCELLED` when a cancel actually won,
 * a message beginning "another page is already being converted" when one is
 * already running, and anything else for a real failure.
 */
export const convertPage = (
  projectId: string,
  pageNo: number,
  voice: string,
  rate: number,
) => invoke<PageAudio>("convert_page_cmd", { projectId, pageNo, voice, rate });

/**
 * *Request* that the conversion running for this page stop. A no-op if none is.
 *
 * Resolving means the request was delivered, NOT that anything has stopped —
 * the engine reads the flag between units of work, so the conversion can run
 * on for up to a minute, and can even finish first, in which case `convertPage`
 * resolves with a fresh take instead of rejecting. Only that promise settling
 * ends the conversion.
 */
export const cancelConversion = (projectId: string, pageNo: number) =>
  invoke<void>("cancel_conversion_cmd", { projectId, pageNo });

export const getPageAudio = (
  projectId: string,
  pageNo: number,
  language: string,
  voice: string,
  rate: number,
) =>
  invoke<PageAudio>("get_page_audio_cmd", { projectId, pageNo, language, voice, rate });

/** Real voices for a language. Empty for the single-speaker MMS languages. */
export const listVoices = (language: string) =>
  invoke<string[]>("list_voices_cmd", { language });

export interface ModelStatus {
  language: string;
  /** Every file present and hash-verified. Not the same as "can speak". */
  present: boolean;
  /** What this language costs in total, from the sidecar's own manifest. */
  bytes: number;
  installedBytes: number;
  /**
   * What an interrupted download left behind. Non-zero means asking again
   * resumes from here rather than starting over, which is worth telling the
   * user before they decide whether to retry.
   */
  partialBytes: number;
}

/**
 * What each language has on disk and what getting it would cost.
 *
 * `present` answers "are the files here", NOT "can this language speak" — a
 * model can verify and still fail to load. `sidecarHealth().engines` is the
 * authority on the second question, and the panel needs both.
 */
export const modelStatus = () => invoke<ModelStatus[]>("model_status_cmd");

/** What `acquireModel` rejects with when a cancel actually won. */
export const MODEL_INSTALL_CANCELLED = "installation cancelled";

/**
 * Install one language's voice model, and resolve only when it is in place.
 *
 * Slow — hundreds of megabytes — and progress arrives meanwhile on the
 * `models://progress` event. Pass `sourceDir` to copy from a folder the user
 * already has instead of downloading; everything after that is identical.
 *
 * Rejects with exactly `MODEL_INSTALL_CANCELLED` when stopped, a message
 * beginning "another voice model is already being installed" when one is, and
 * the sidecar's own untranslated words for anything else — a checksum failure,
 * or a folder that is missing files, which names them.
 */
export const acquireModel = (language: string, sourceDir?: string) =>
  invoke<void>("acquire_model_cmd", { language, sourceDir: sourceDir ?? null });

/**
 * *Request* that the running installation for this language stop. A no-op if
 * none is.
 *
 * Unlike cancelling a conversion this is cheap to act on and cheap to undo:
 * the downloader checks between chunks, and what has already arrived is kept,
 * so starting the same language again resumes rather than restarting.
 */
export const cancelModelAcquisition = (language: string) =>
  invoke<void>("cancel_model_acquisition_cmd", { language });

/**
 * Delete one language's voice model, scratch files included.
 *
 * Rejects, in English, while that language is being installed, converted or
 * exported, and with the sidecar's own reason if the files could not be
 * deleted. Audio already made is untouched.
 */
export const removeModel = (language: string) =>
  invoke<void>("remove_model_cmd", { language });

/** What the Export dialog shows before anything starts. */
export interface ExportPlan {
  total: number;
  ready: number;
  toSynthesize: number;
  /** Of `toSynthesize`, pages whose take is in another voice or speed and will be replaced. */
  replacing: number;
  empty: number[];
}

export type ExportPhase = "synthesizing" | "sweeping" | "stitching";

export interface PageFailure {
  pageNo: number;
  /** The engine's own words; untranslated. */
  message: string;
}

export type ExportOutcome =
  | { kind: "done"; path: string; durationMs: number; empty: number[] }
  | { kind: "failed"; pages: PageFailure[]; empty: number[] }
  | { kind: "cancelled"; kept: number }
  | { kind: "error"; message: string };

export type ExportStatus =
  | {
      state: "running";
      projectId: string;
      title: string;
      phase: ExportPhase;
      /** Pages finished in the current pass, out of `total`. */
      done: number;
      total: number;
      pageNo: number | null;
      /** The current page's progress, or the stitch's, 0-1. */
      pageProgress: number;
      /** Pages synthesized so far in this run, across passes. */
      synthesized: number;
      startedAtMs: number;
    }
  | { state: "finished"; projectId: string; title: string; outcome: ExportOutcome };

export type RunningExport = Extract<ExportStatus, { state: "running" }>;

export const exportPlan = (
  projectId: string,
  voice: string,
  rate: number,
  pages: number[],
) => invoke<ExportPlan>("export_plan_cmd", { projectId, voice, rate, pages });

/**
 * Start an export and return at once; it runs in the background for as long
 * as it takes. Progress arrives on `export://progress`, each finished page on
 * `export://page-done`, and the end on `export://finished`. Rejects straight
 * away when the slot is busy, a page is outside the book, or `outPath` cannot be written.
 */
export const startExport = (
  projectId: string,
  voice: string,
  rate: number,
  pages: number[],
  outPath: string,
) => invoke<void>("start_export_cmd", { projectId, voice, rate, pages, outPath });

/** *Request* a stop. The run ends with a `cancelled` outcome once the current step notices. */
export const cancelExport = () => invoke<void>("cancel_export_cmd");

/** The current export, or its unseen result, or null. */
export const exportStatus = () => invoke<ExportStatus | null>("export_status_cmd");

/** Forget a finished run's result. A no-op while one is running. */
export const dismissExport = () => invoke<void>("dismiss_export_cmd");
