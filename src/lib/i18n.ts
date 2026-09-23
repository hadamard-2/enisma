import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";

import am from "@/locales/am.json";
import en from "@/locales/en.json";
import om from "@/locales/om.json";
import ti from "@/locales/ti.json";

/**
 * One catalogue serves two audiences, so it carries more than the app needs:
 * every entry is `{ message, context }`, where `context` exists to tell a
 * translator where the string appears. Stripping it here keeps `en.json` the
 * single source of truth — the alternative, generating a second runtime-only
 * file, is a copy that can drift.
 */
type Entry = { message: string; context: string };
type Node = { [key: string]: Node | Entry };
type Messages = { [key: string]: Messages | string };

const isEntry = (v: unknown): v is Entry =>
  typeof v === "object" && v !== null && typeof (v as Entry).message === "string";

/**
 * Replace every `{ message, context }` leaf with its message, at any depth.
 *
 * Recursive because groups nest (`voices.accent.american`). A loader that only
 * looked two levels down handed i18next an object where a string belonged,
 * and the UI showed the raw key instead of the text.
 */
function strip(node: Node): Messages {
  const out: Messages = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = isEntry(value) ? value.message : strip(value);
  }
  return out;
}

function messages(raw: unknown): Messages {
  const { _meta, ...catalogue } = raw as Node & { _meta?: unknown };
  void _meta;
  return strip(catalogue as Node);
}

/**
 * Catalogues are bundled, not fetched. Enisma has to work with no network, and
 * they are a few KB each — the same reason the fonts are bundled.
 *
 * Adding a language is an import plus a line here, and flipping its
 * `translated` flag in ./app-language.
 */
const RESOURCES = {
  en: { translation: messages(en) },
  am: { translation: messages(am) },
  ti: { translation: messages(ti) },
  om: { translation: messages(om) },
};

export const STORAGE_KEY = "appLanguage";

/**
 * Every language the interface offers — not every language it has strings for.
 * A code with no entry in RESOURCES is selectable and falls back to English,
 * which is what lets the setting be honest about what is planned.
 */
export const APP_LANGUAGE_CODES = ["en", "am", "ti", "om"] as const;
export type AppLanguageCode = (typeof APP_LANGUAGE_CODES)[number];

export const isAppLanguage = (v: string): v is AppLanguageCode =>
  (APP_LANGUAGE_CODES as readonly string[]).includes(v);

/**
 * Read synchronously at module load, before React renders. Deferring it would
 * paint the English UI first and correct it a frame later.
 *
 * Validated against the offered codes rather than against RESOURCES: a saved
 * language whose catalogue has not landed yet is still the user's choice, and
 * resetting it to English on every restart would quietly throw it away.
 */
function savedLanguage(): AppLanguageCode {
  if (typeof window === "undefined") return "en";
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && isAppLanguage(saved) ? saved : "en";
}

void i18next
  // Plurals are the whole reason for this plugin. The catalogue is written in
  // ICU MessageFormat, so each language declares its own plural categories
  // rather than being forced into English's one/other split.
  .use(new ICU())
  .use(initReactI18next)
  .init({
    resources: RESOURCES,
    lng: savedLanguage(),
    fallbackLng: "en",
    // React escapes for us; letting i18next escape as well double-encodes
    // anything with an apostrophe or an ampersand.
    interpolation: { escapeValue: false },
  });

/** Keep the document in step, so `:lang()` rules and spellcheck follow along. */
export function applyDocumentLanguage(lng: string) {
  if (typeof document !== "undefined") document.documentElement.lang = lng;
}

applyDocumentLanguage(i18next.language);

export default i18next;
