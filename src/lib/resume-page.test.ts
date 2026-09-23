import { describe, expect, it } from "vitest";
import { resumePage } from "./resume-page";

const pages = [
  { pageNo: 1, done: true },
  { pageNo: 2, done: false },
  { pageNo: 3, done: false },
];

describe("resumePage", () => {
  it("reopens on the page the user left", () => {
    expect(resumePage(pages, 3)).toBe(3);
  });

  it("reopens on a page marked done if that is where the user left", () => {
    expect(resumePage(pages, 1)).toBe(1);
  });

  it("falls back to the first unfinished page when nothing is remembered", () => {
    expect(resumePage(pages, null)).toBe(2);
  });

  it("ignores a remembered page the project does not have", () => {
    expect(resumePage(pages, 9)).toBe(2);
  });

  it("opens page 1 when every page is done", () => {
    expect(resumePage([{ pageNo: 1, done: true }, { pageNo: 2, done: true }], null)).toBe(1);
  });
});
