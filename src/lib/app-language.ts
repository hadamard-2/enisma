import { useCallback, useEffect, useState } from "react";

/**
 * The language of the interface itself — not the language of a project's
 * textbook (that's `LANGUAGES` in ./languages, which picks a TTS voice).
 *
 * Only English exists today: the UI's strings are written in the components,
 * with no translation catalogue behind them. The others are listed so the
 * setting is honest about what is planned and so the stored value is already
 * in place when catalogues arrive; choosing one changes nothing yet.
 */
export const APP_LANGUAGES = [
  { code: "en", label: "English", translated: true },
  { code: "am", label: "አማርኛ · Amharic", translated: false },
  { code: "ti", label: "ትግርኛ · Tigrinya", translated: false },
  { code: "om", label: "Afaan Oromoo · Oromo", translated: false },
] as const;

export type AppLanguageCode = (typeof APP_LANGUAGES)[number]["code"];

const STORAGE_KEY = "appLanguage";
const DEFAULT: AppLanguageCode = "en";

const isCode = (v: string | null): v is AppLanguageCode =>
  APP_LANGUAGES.some((l) => l.code === v);

export function useAppLanguage() {
  const [language, setLanguage] = useState<AppLanguageCode>(() => {
    const saved = typeof window === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return isCode(saved) ? saved : DEFAULT;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
  }, [language]);

  return [language, useCallback((l: AppLanguageCode) => setLanguage(l), [])] as const;
}
