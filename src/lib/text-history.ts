/**
 * Undo/redo for the page editor.
 *
 * Owned by the app rather than left to the textarea because the textarea's
 * native stack does not work in the webview (Ctrl+Z did nothing), and even
 * where it does it spans page switches: undoing on page 6 could restore the
 * text of page 5 into it. This history is reset whenever the editor loads a
 * page, so it only ever holds states of the page on screen.
 *
 * Pure and in its own module so it can be tested: vitest only picks up
 * `src/**​/*.test.ts`, so nothing in a `.tsx` file is exercised by any test.
 */

export type TextState = { value: string; selectionStart: number; selectionEnd: number };

type Kind = "insert" | "delete" | "other";

/** Keystrokes of the same kind closer together than this are one undo step. */
export const COALESCE_MS = 1000;
/** Oldest states are dropped past this many, so a long session stays bounded. */
export const HISTORY_LIMIT = 500;

function kindOf(prev: string, next: string): Kind {
  const d = next.length - prev.length;
  if (d === 1) return "insert";
  if (d === -1) return "delete";
  return "other";
}

export class TextHistory {
  private states: TextState[];
  private index = 0;
  private lastKind: Kind = "other";
  private lastAt = -Infinity;

  constructor(initial: TextState) {
    this.states = [initial];
  }

  /** Start over from `initial` — a different page, or text loaded from disk. */
  reset(initial: TextState): void {
    this.states = [initial];
    this.index = 0;
    this.lastKind = "other";
    this.lastAt = -Infinity;
  }

  get current(): TextState {
    return this.states[this.index]!;
  }

  /**
   * Record the state after an edit. Runs of single-character typing (or
   * deleting) merge into one step, as in any editor, so undo takes back a
   * word or a phrase rather than one letter; a pause, a newline, a paste or a
   * change of direction starts a new step.
   */
  record(next: TextState, now: number): void {
    const prev = this.current;
    if (next.value === prev.value) {
      // Same text, new caret: keep the caret so undo lands where you were.
      this.states[this.index] = next;
      return;
    }
    const kind = kindOf(prev.value, next.value);
    const typedNewline = kind === "insert" && next.value[next.selectionStart - 1] === "\n";
    const merge =
      kind !== "other" &&
      !typedNewline &&
      kind === this.lastKind &&
      now - this.lastAt < COALESCE_MS &&
      this.index > 0;

    // Anything after the current state is a future the new edit abandons.
    this.states.length = this.index + 1;
    if (merge) {
      this.states[this.index] = next;
    } else {
      this.states.push(next);
      this.index++;
      if (this.states.length > HISTORY_LIMIT) {
        this.states.shift();
        this.index--;
      }
    }
    this.lastKind = typedNewline ? "other" : kind;
    this.lastAt = now;
  }

  /** The state to show, or null when there is nothing to undo. */
  undo(): TextState | null {
    if (this.index === 0) return null;
    this.index--;
    this.lastKind = "other";
    return this.current;
  }

  /** The state to show, or null when there is nothing to redo. */
  redo(): TextState | null {
    if (this.index >= this.states.length - 1) return null;
    this.index++;
    this.lastKind = "other";
    return this.current;
  }
}
