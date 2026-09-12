/**
 * Which faint placeholder belongs inside an empty text editor, if any.
 *
 * Three inputs, four outcomes, and the distinction that matters is the one
 * SQLite already draws: `source_text` NULL means extraction never ran for this
 * page, `''` means it ran and the page genuinely had no text layer. A page
 * that extracted real prose and was then blanked by the user is a third case
 * again — it is neither "still reading" nor "no text layer", and saying either
 * would be false.
 */
export type PagePlaceholder = "noTextLayer" | "extracting" | "emptyText";

export function placeholderFor(state: {
  /** The stored extraction result: NULL = never extracted, '' = nothing found. */
  sourceText: string | null;
  /** The correction shown in the editor, or null when there is none. */
  editedText: string | null;
  /** Whether a re-extraction is actually in flight for this project. */
  repairing: boolean;
}): PagePlaceholder | null {
  const { sourceText, editedText, repairing } = state;

  // The editor shows the correction when there is one, and the extraction
  // otherwise. Anything on screen means no placeholder belongs.
  const shown = editedText ?? sourceText ?? "";
  if (shown !== "") return null;

  // Extraction found text but the editor is empty: the user cleared it.
  // Nothing is coming to fill it back in, so offer them the way forward.
  if (sourceText !== null && sourceText !== "") return "emptyText";

  // Never extracted. Only claim to be reading when a repair really is running;
  // a repair that failed (or was never started) must not leave that standing.
  if (sourceText === null) return repairing ? "extracting" : "emptyText";

  // Extracted, and the page held no text at all.
  return "noTextLayer";
}
