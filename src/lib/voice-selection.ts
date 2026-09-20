/**
 * Reconciling the stored voice against the voice list a language offers.
 *
 * Pure and in its own module so it can be tested: vitest's `include` is
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 * The loader effect is wiring; this is the part with rules in it.
 */

/** The voice to select, and whether that choice must be written to the project. */
export type VoiceReconciliation = { voice: string; persist: boolean };

/**
 * Decide which voice to select once a language's voice list has loaded.
 *
 * An empty list never clears the stored voice. The sidecar answers with an
 * empty list both for a single-speaker language and for a language whose
 * models have not been downloaded yet, so treating it as "this language has no
 * voice" would wipe a good stored preference on a machine that is still
 * downloading - unrecoverable, since the value is gone before the list that
 * contains it ever arrives. A non-empty list is authoritative: a selection it
 * does not contain names a voice this language cannot speak with, so the first
 * voice is selected and persisted in its place.
 *
 * The known consequence is that a voice may stay stored while a language that
 * offers none is open. That value is inert - a single-speaker engine ignores
 * it, and a take's freshness is compared against whatever was stored when the
 * take was made.
 */
export function reconcileVoice(
  list: readonly string[],
  current: string,
): VoiceReconciliation {
  if (list.length === 0) return { voice: current, persist: false };
  if (list.includes(current)) return { voice: current, persist: false };
  return { voice: list[0], persist: true };
}
