import type { LanguageCode } from "./languages";

/**
 * NOT REAL VOICES. Cosmetic placeholders so the settings panel renders until
 * M4 wires the TTS engines and the real Kokoro voice list.
 */
export const PLACEHOLDER_VOICES: Record<LanguageCode, string[]> = {
  en: ["Aria — warm female", "Marcus — clear male", "Imani — neutral"],
  am: ["Selam — female"],
  ti: ["Hiwot — female"],
  om: ["Caaltuu — female"],
};
