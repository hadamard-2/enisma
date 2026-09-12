import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { applyDocumentLanguage, isAppLanguage, STORAGE_KEY, type AppLanguageCode } from "./i18n";

/**
 * The language of the interface itself — not the language of a project's
 * textbook (that's `LANGUAGES` in ./languages, which picks a TTS voice).
 *
 * `translated` says whether a catalogue exists. The ones without still appear,
 * so the setting is honest about what is planned; choosing one falls back to
 * English until `src/locales/<code>.json` lands and is registered in ./i18n.
 */
export const APP_LANGUAGES = [
  { code: "en", translated: true },
  { code: "am", translated: true },
  { code: "ti", translated: true },
  { code: "om", translated: true },
] as const satisfies readonly {
  code: AppLanguageCode;
  translated: boolean;
}[];

/**
 * Catalogue key for an interface language's own name.
 *
 * These are endonyms — "አማርኛ · Amharic" — and every catalogue is meant to
 * repeat them verbatim, so that someone who cannot read the language the app
 * is currently in can still find their own. They live in the catalogue anyway
 * rather than here, so there is one copy to keep right instead of two.
 */
export function appLanguageLabelKey(code: string): string {
  return `appLanguage.${code}`;
}

export type { AppLanguageCode };

/**
 * i18next holds the active language, so this hook reads from it rather than
 * keeping a second copy: two sources of truth would let the dropdown and the
 * rendered strings disagree after a language change from anywhere else.
 */
export function useAppLanguage() {
  const { i18n } = useTranslation();
  // `language` is what was asked for, `resolvedLanguage` is what the lookup
  // actually landed on. The dropdown must show the former: picking a language
  // with no catalogue yet resolves to English, and reading that back would
  // silently undo the user's choice in front of them.
  const current = isAppLanguage(i18n.language) ? i18n.language : "en";

  const set = useCallback(
    (l: AppLanguageCode) => {
      localStorage.setItem(STORAGE_KEY, l);
      applyDocumentLanguage(l);
      void i18n.changeLanguage(l);
    },
    [i18n],
  );

  return [current, set] as const;
}
