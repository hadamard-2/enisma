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
  pages: PageMeta[];
}

export interface PageText {
  sourceText: string | null;
  editedText: string | null;
}

export const listProjects = () => invoke<ProjectSummary[]>("list_projects_cmd");

export const getProject = (id: string) => invoke<ProjectDetail>("get_project_cmd", { id });

export const importProject = (title: string, language: string, srcPath: string) =>
  invoke<string>("import_project_cmd", { title, language, srcPath });

export const updateProject = (
  id: string,
  patch: { title?: string; language?: string; rate?: number },
) => invoke<void>("update_project_cmd", { id, ...patch });

export const getPage = (projectId: string, pageNo: number) =>
  invoke<PageText>("get_page_cmd", { projectId, pageNo });

export const savePageText = (projectId: string, pageNo: number, text: string) =>
  invoke<void>("save_page_text_cmd", { projectId, pageNo, text });

export const setPageDone = (projectId: string, pageNo: number, done: boolean) =>
  invoke<void>("set_page_done_cmd", { projectId, pageNo, done });
