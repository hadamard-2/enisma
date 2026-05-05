export type ProjectStatus = "in-progress" | "done" | "new";
export type CoverPalette = "warm" | "teal" | "rose" | "amber" | "slate";

export interface Project {
    id: string;
    title: string;
    publisher: string;
    language: string;
    pagesTotal: number;
    pagesReviewed: number;
    lastEdited: string;
    status: ProjectStatus;
    cover: CoverPalette;
}

export const PROJECTS: Project[] = [
    {
        id: "p1",
        title: "Grade 7 General Science",
        publisher: "Federal Ministry of Education · 2023",
        language: "English",
        pagesTotal: 184,
        pagesReviewed: 142,
        lastEdited: "2 hours ago",
        status: "in-progress",
        cover: "warm",
    },
    {
        id: "p2",
        title: "አማርኛ — ሰባተኛ ክፍል",
        publisher: "Federal Ministry of Education · 2022",
        language: "Amharic",
        pagesTotal: 96,
        pagesReviewed: 96,
        lastEdited: "yesterday",
        status: "done",
        cover: "teal",
    },
    {
        id: "p3",
        title: "Mathematics — Grade 5",
        publisher: "Federal Ministry of Education · 2024",
        language: "English",
        pagesTotal: 220,
        pagesReviewed: 38,
        lastEdited: "3 days ago",
        status: "in-progress",
        cover: "rose",
    },
    {
        id: "p4",
        title: "Afaan Oromoo — Kutaa 6ffaa",
        publisher: "Oromia Education Bureau · 2023",
        language: "Oromo",
        pagesTotal: 128,
        pagesReviewed: 0,
        lastEdited: "just now",
        status: "new",
        cover: "amber",
    },
    {
        id: "p5",
        title: "Civics & Ethical Education — Grade 8",
        publisher: "Federal Ministry of Education · 2021",
        language: "English",
        pagesTotal: 156,
        pagesReviewed: 156,
        lastEdited: "last week",
        status: "done",
        cover: "slate",
    },
    {
        id: "p6",
        title: "ትግርኛ — ሻድሻይ ክፍሊ",
        publisher: "Tigray Education Bureau · 2022",
        language: "Tigrigna",
        pagesTotal: 110,
        pagesReviewed: 64,
        lastEdited: "5 days ago",
        status: "in-progress",
        cover: "warm",
    },
];
