import { describe, expect, it } from "vitest";
import { audioStateFor, formatDuration } from "./audio-state";

const base = { path: null, stale: true, converting: false, hasText: true };

describe("audioStateFor", () => {
  it("reports conversion above everything else", () => {
    expect(audioStateFor({ ...base, converting: true })).toBe("converting");
    expect(
      audioStateFor({ ...base, converting: true, hasText: false }),
    ).toBe("converting");
  });

  it("refuses to offer conversion for a page with no text", () => {
    expect(audioStateFor({ ...base, hasText: false })).toBe("noText");
  });

  it("reports absent when the page has never been converted", () => {
    expect(audioStateFor({ ...base, path: null })).toBe("absent");
  });

  it("reports stale when a take exists but no longer matches", () => {
    expect(
      audioStateFor({ ...base, path: "/data/page-1.wav", stale: true }),
    ).toBe("stale");
  });

  it("reports fresh when the take matches the text and settings", () => {
    expect(
      audioStateFor({ ...base, path: "/data/page-1.wav", stale: false }),
    ).toBe("fresh");
  });

  it("keeps a stale take playable rather than treating it as absent", () => {
    // The distinction the panel needs: 'stale' still has a path to play.
    expect(
      audioStateFor({ ...base, path: "/data/page-1.wav", stale: true }),
    ).not.toBe("absent");
  });

  it("reports a failed conversion, so it cannot fail silently", () => {
    expect(
      audioStateFor({ ...base, error: "synthesis failed" }),
    ).toBe("error");
  });

  it("keeps a live conversion above a previous failure", () => {
    // Retrying sets `converting` while the old message is still on screen;
    // the panel must show the retry, not the error it is already answering.
    expect(
      audioStateFor({ ...base, converting: true, error: "synthesis failed" }),
    ).toBe("converting");
  });

  it("reports the error even when the page's text was emptied", () => {
    // 'Nothing to read on this page' would make a conversion the user
    // actually started and watched fail look as if it never happened.
    expect(
      audioStateFor({ ...base, hasText: false, error: "synthesis failed" }),
    ).toBe("error");
  });

  it("does not let a failure hide a take that still plays", () => {
    // Deliberate: the error outranks 'stale'/'fresh' because it is the
    // outcome of the user's last action, but the path is untouched, so the
    // panel still hands the player something to play.
    expect(
      audioStateFor({
        ...base,
        path: "/data/page-1.wav",
        stale: false,
        error: "synthesis failed",
      }),
    ).toBe("error");
  });
});

describe("formatDuration", () => {
  it("renders a zero-length or unknown take as 0:00", () => {
    expect(formatDuration(null)).toBe("0:00");
    expect(formatDuration(0)).toBe("0:00");
  });

  it("pads seconds to two digits", () => {
    expect(formatDuration(9_000)).toBe("0:09");
    expect(formatDuration(102_000)).toBe("1:42");
  });

  it("truncates rather than rounds, so the clock never overshoots", () => {
    expect(formatDuration(1_999)).toBe("0:01");
  });

  it("carries past an hour into the minutes column", () => {
    expect(formatDuration(3_723_000)).toBe("62:03");
  });
});
