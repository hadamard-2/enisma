export type ProjectStatus = "in-progress" | "done" | "new";
export type CoverPalette = "warm" | "teal" | "rose" | "amber" | "slate";

export interface Project {
    id: string;
    title: string;
    language: string;
    pagesTotal: number;
    pagesReviewed: number;
    lastEdited: string;
    status: ProjectStatus;
    cover: CoverPalette;
}
