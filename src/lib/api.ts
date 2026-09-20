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
  pages: PageMeta[];
  /** Pages never extracted (`source_text IS NULL`). Non-zero triggers repair. */
  pagesMissingText: number;
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
  /** No take, or one that no longer matches the text, voice and rate. */
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
  voice: string,
  rate: number,
) => invoke<PageAudio>("get_page_audio_cmd", { projectId, pageNo, voice, rate });

/** Real voices for a language. Empty for the single-speaker MMS languages. */
export const listVoices = (language: string) =>
  invoke<string[]>("list_voices_cmd", { language });
