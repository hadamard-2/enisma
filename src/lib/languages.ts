export type LanguageCode = "en" | "am" | "ti" | "om";

export interface Language {
  code: LanguageCode;
  label: string;
}

/** The four supported languages. This is the single source of spelling. */
export const LANGUAGES: Language[] = [
  { code: "en", label: "English" },
  { code: "am", label: "Amharic" },
  { code: "ti", label: "Tigrigna" },
  { code: "om", label: "Oromo" },
];

export function labelForCode(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
