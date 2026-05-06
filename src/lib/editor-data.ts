export interface PageMeta {
  n: number;
  done: boolean;
}

export interface PageContent {
  chapter: string;
  heading: string;
  body: string;
  figure?: string;
}

export const TOTAL_PAGES = 184;
export const DONE_THROUGH = 142;

export function buildInitialPages(): PageMeta[] {
  const arr: PageMeta[] = [];
  for (let i = 1; i <= TOTAL_PAGES; i++) {
    arr.push({ n: i, done: i <= DONE_THROUGH });
  }
  return arr;
}

const PAGE_CONTENT: Record<number, PageContent> = {
  18: {
    chapter: "Chapter 2",
    heading: "Photosynthesis",
    body: `Photosynthesis is the process by which green plants and some other organisms use sunlight to synthesise foods with the help of chlorophyll. During this process, plants take in carbon dioxide from the air and water from the soil through their roots.

The overall reaction can be written as:

  6 CO₂ + 6 H₂O  →  C₆H₁₂O₆ + 6 O₂

Photosynthesis takes place mainly in the leaves of the plant. Inside the leaf cells are tiny structures called chloroplasts, which contain the green pigment chlorophyll. Chlorophyll absorbs energy from sunlight and uses it to convert carbon dioxide and water into glucose and oxygen.

Activity 2.3 — In groups, observe a leaf under a microscope. Identify the chloroplasts and discuss why most leaves are green.`,
    figure:
      "Figure 2.4 — Cross-section of a leaf showing the chloroplasts and stomata.",
  },
  19: {
    chapter: "Chapter 2",
    heading: "Respiration in Plants",
    body: `Like all living things, plants also respire. Respiration is the process of releasing energy from food. Unlike photosynthesis, respiration takes place all the time — both during the day and at night — in every living cell of the plant.

The word equation for respiration is:

  Glucose + Oxygen  →  Carbon dioxide + Water + Energy

You can think of photosynthesis and respiration as opposite processes. Photosynthesis stores energy from sunlight in glucose; respiration releases that energy so the plant can grow, repair itself, and reproduce.`,
  },
  20: {
    chapter: "Chapter 2",
    heading: "Transport in Plants",
    body: `Water and dissolved minerals are absorbed by the roots and transported to the leaves through tubes called xylem. Food made in the leaves is transported to the rest of the plant through tubes called phloem.

Together, the xylem and phloem make up the vascular tissue of the plant.`,
  },
};

const DEFAULT_PAGE: PageContent = {
  chapter: "Chapter 2",
  heading: "Plant Processes",
  body: `[ Extracted text for this page will appear here. The operator can correct OCR errors, fix line breaks, and remove page-header artefacts before the text is sent to the audiobook.

Tip — keep paragraphs intact. The TTS engine reads better when sentences flow naturally. ]`,
};

export function getPageContent(n: number): PageContent {
  return PAGE_CONTENT[n] ?? { ...DEFAULT_PAGE };
}

export const VOICES: Record<string, string[]> = {
  English: ["Aria — warm female", "Marcus — clear male", "Imani — neutral"],
  Amharic: ["Selam — female", "Dawit — male"],
  Tigrinya: ["Hiwot — female", "Tesfay — male"],
  Tigrigna: ["Hiwot — female", "Tesfay — male"],
  Oromo: ["Caaltuu — female", "Boruu — male"],
};

export const LANGUAGES = ["English", "Amharic", "Tigrinya", "Oromo"];
