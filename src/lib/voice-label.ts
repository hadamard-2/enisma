/**
 * What the voice picker shows for a voice, derived from its engine id.
 *
 * Pure and in its own module so it can be tested: vitest only picks up
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 */

export type Accent = "american" | "british";
export type Gender = "female" | "male";

export type VoiceLabel = {
  /** The voice's own name, already capitalized for display. */
  name: string;
  /** Null when the id names an accent the app has no label for. */
  accent: Accent | null;
  gender: Gender | null;
};

const ACCENTS: Record<string, Accent> = { a: "american", b: "british" };
const GENDERS: Record<string, Gender> = { f: "female", m: "male" };

// Kokoro's English voice ids encode accent, gender and name: `af_heart` is an
// American female voice called Heart, `bm_george` a British male called
// George. The convention is Kokoro's own, so it is parsed only for English.
const KOKORO_ID = /^([a-z])([fm])_([a-z][a-z0-9_]*)$/;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Split a Kokoro voice id into the parts the picker shows.
 *
 * An id that does not follow the convention is shown as it is rather than
 * guessed at, so a voice added upstream under a new scheme stays selectable.
 */
export function describeKokoroVoice(id: string): VoiceLabel {
  const m = KOKORO_ID.exec(id);
  if (!m) return { name: id, accent: null, gender: null };
  const [, accent, gender, name] = m;
  return {
    name: name.split("_").filter(Boolean).map(capitalize).join(" "),
    accent: ACCENTS[accent] ?? null,
    gender: GENDERS[gender] ?? null,
  };
}

// The MMS languages each have exactly one speaker, all male and each with a
// single accent, so their voice is shown with a name and no accent. The name
// itself is written per interface language, so only its catalogue key lives
// here.
const SINGLE_SPEAKER = new Set(["am", "ti", "om"]);

/** The fixed voice of a single-speaker language, or null if it offers a choice. */
export function singleSpeakerVoice(
  language: string,
): { nameKey: string; gender: Gender } | null {
  if (!SINGLE_SPEAKER.has(language)) return null;
  return { nameKey: `voices.name.${language}`, gender: "male" };
}
