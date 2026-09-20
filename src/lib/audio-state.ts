/**
 * What the audio half of the settings panel should be showing.
 *
 * Conversion is explicit and two-stage: nothing is synthesized until the user
 * asks, and a page takes 40-100 seconds to convert. So the panel has to say
 * which of the resting states it is in, and "stale" is the one that matters
 * most — a take that no longer matches the text or settings is still worth
 * playing, so it must not collapse into "absent".
 *
 * "cancelling" is deliberately NOT one of these. Asking to cancel does not
 * stop the conversion: the backend only requests a stop, the engine reads the
 * flag between units of work, and truthful progress keeps arriving until the
 * conversion command finally settles — which it may do by *succeeding*, if the
 * take was finished before the flag was read. So cancelling is a flavour of
 * "converting", not a state of its own, and the panel renders it as such.
 */
export type AudioPanelState =
  | "converting"
  | "error"
  | "noText"
  | "absent"
  | "stale"
  | "fresh";

export function audioStateFor(state: {
  /** Absolute path of the stored take, or null when there is none. */
  path: string | null;
  /** Whether the take no longer matches the current text, voice and rate. */
  stale: boolean;
  /** Whether a conversion is in flight for this page right now. */
  converting: boolean;
  /** Whether the page has anything to read at all. */
  hasText: boolean;
  /**
   * The untranslated message from a conversion that failed, or null. A
   * cancellation is not an error and must be cleared to null by the caller.
   */
  error?: string | null;
}): AudioPanelState {
  const { path, stale, converting, hasText, error = null } = state;

  // A conversion in flight outranks everything, including a page whose text
  // was emptied while it ran, and including the message from the earlier
  // attempt this one is retrying.
  if (converting) return "converting";

  // A failure is the outcome of something the user explicitly asked for and
  // watched for a minute. It outranks every resting state — including
  // "noText", because a page emptied after the failure would otherwise make a
  // conversion that visibly ran look as if it never happened. It costs the
  // panel nothing: `path` is untouched, so any previous take still plays.
  if (error !== null) return "error";

  // Nothing to read means nothing to offer; the Convert button is disabled.
  if (!hasText) return "noText";

  if (path === null) return "absent";

  return stale ? "stale" : "fresh";
}

/**
 * A duration in milliseconds as `m:ss`.
 *
 * Truncates rather than rounds: a clock that reads 1:42 for a take of 1:41.6
 * would sit on its final second having apparently already ended. Minutes are
 * not carried into hours — a single textbook page is at most a couple of
 * minutes of speech, and "62:03" is clearer there than "1:02:03".
 */
export function formatDuration(ms: number | null): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Abandon a conversion the user is walking away from.
 *
 * Leaving the editor while a page is converting used to strand the backend's
 * single conversion slot: the component unmounted, its handlers became
 * no-ops, and nothing ever asked for a stop — so every project in the app
 * refused to convert until the abandoned job finished on its own, advising
 * the user to cancel something they no longer had any way to reach.
 *
 * Two things this deliberately does not do. It does not report failure:
 * there is nobody left to tell, and the common case — a job that already
 * finished and was pruned — is not even an error on the Rust side. And it
 * does not make the wait vanish: cancellation is two-phase, so the slot stays
 * claimed until the engine next reads the flag. It starts the stop, which is
 * strictly sooner than letting the job run to completion.
 *
 * @param pageNo The page the conversion was STARTED on, or null when nothing
 *   is in flight — in which case no call is made at all.
 */
export function cancelAbandonedConversion(
  pageNo: number | null,
  cancel: (pageNo: number) => Promise<unknown>,
): void {
  if (pageNo === null) return;
  void cancel(pageNo).catch(() => {});
}
