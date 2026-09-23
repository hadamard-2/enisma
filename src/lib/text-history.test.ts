import { describe, expect, it } from "vitest";
import { COALESCE_MS, HISTORY_LIMIT, TextHistory } from "./text-history";

const st = (value: string, caret = value.length) => ({
  value,
  selectionStart: caret,
  selectionEnd: caret,
});

/** Type `word` one character at a time, `gap` ms apart, starting at `t`. */
function type(h: TextHistory, base: string, word: string, t: number, gap = 50): number {
  let v = base;
  for (const ch of word) {
    v += ch;
    h.record(st(v), t);
    t += gap;
  }
  return t;
}

describe("TextHistory", () => {
  it("undoes and redoes back to where it was", () => {
    const h = new TextHistory(st("a"));
    h.record(st("ab"), 0);
    h.record(st("ab cd"), 5000);
    expect(h.undo()?.value).toBe("ab");
    expect(h.undo()?.value).toBe("a");
    expect(h.undo()).toBeNull();
    expect(h.redo()?.value).toBe("ab");
    expect(h.redo()?.value).toBe("ab cd");
    expect(h.redo()).toBeNull();
  });

  it("takes back a burst of typing as one step, not letter by letter", () => {
    const h = new TextHistory(st(""));
    type(h, "", "hello", 0);
    expect(h.undo()?.value).toBe("");
  });

  it("starts a new step after a pause", () => {
    const h = new TextHistory(st(""));
    const t = type(h, "", "one", 0);
    type(h, "one", " two", t + COALESCE_MS + 1);
    expect(h.undo()?.value).toBe("one");
    expect(h.undo()?.value).toBe("");
  });

  it("starts a new step at a newline", () => {
    const h = new TextHistory(st(""));
    type(h, "", "line\nnext", 0);
    expect(h.undo()?.value).toBe("line\n");
    expect(h.undo()?.value).toBe("line");
    expect(h.undo()?.value).toBe("");
  });

  it("keeps typing and deleting as separate steps", () => {
    const h = new TextHistory(st(""));
    type(h, "", "abc", 0);
    h.record(st("ab"), 200);
    h.record(st("a"), 250);
    expect(h.undo()?.value).toBe("abc");
    expect(h.undo()?.value).toBe("");
  });

  it("treats a paste as its own step", () => {
    const h = new TextHistory(st("a"));
    h.record(st("ab"), 0);
    h.record(st("ab pasted text"), 10);
    expect(h.undo()?.value).toBe("ab");
  });

  it("drops the redo future once a new edit is made", () => {
    const h = new TextHistory(st("a"));
    h.record(st("ab"), 0);
    h.undo();
    h.record(st("ax"), 5000);
    expect(h.redo()).toBeNull();
    expect(h.undo()?.value).toBe("a");
  });

  it("does not merge the first edit after an undo into the state before it", () => {
    const h = new TextHistory(st(""));
    type(h, "", "ab", 0);
    h.undo();
    h.record(st("x"), 120);
    expect(h.undo()?.value).toBe("");
  });

  it("restores the caret with the text", () => {
    const h = new TextHistory(st("hello", 2));
    h.record(st("heXllo", 3), 0);
    expect(h.undo()).toEqual({ value: "hello", selectionStart: 2, selectionEnd: 2 });
  });

  it("forgets everything on reset", () => {
    const h = new TextHistory(st("page five"));
    h.record(st("page five edited"), 0);
    h.reset(st("page six"));
    expect(h.undo()).toBeNull();
    expect(h.current.value).toBe("page six");
  });

  it("stays bounded", () => {
    const h = new TextHistory(st(""));
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h.record(st("x".repeat(i * 2)), i * 5000);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(HISTORY_LIMIT - 1);
  });
});
