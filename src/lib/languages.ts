export type LanguageCode = "en" | "am" | "ti" | "om";

export interface Language {
  code: LanguageCode;
}

/** The four supported languages. This is the single source of the code list. */
export const LANGUAGES: Language[] = [
  { code: "en" },
  { code: "am" },
  { code: "ti" },
  { code: "om" },
];

/**
 * Catalogue key for a textbook language's display name.
 *
 * These names are shown in the app's current interface language, so they live
 * in the catalogue rather than here — unlike the interface-language list in
 * ./app-language, whose labels stay in their own script on purpose.
 */
export function languageLabelKey(code: string): string {
  return `contentLanguage.${code}`;
}
