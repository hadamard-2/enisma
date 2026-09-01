import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

const NOW = new Date("2026-09-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("relativeTime", () => {
  it("reports seconds as just now", () => {
    expect(relativeTime(ago(30_000), NOW)).toBe("just now");
  });

  it("pluralises minutes correctly", () => {
    expect(relativeTime(ago(60_000), NOW)).toBe("1 minute ago");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5 minutes ago");
  });

  it("reports hours", () => {
    expect(relativeTime(ago(2 * 3_600_000), NOW)).toBe("2 hours ago");
  });

  it("reports one day as yesterday", () => {
    expect(relativeTime(ago(25 * 3_600_000), NOW)).toBe("yesterday");
  });

  it("reports one week as last week", () => {
    expect(relativeTime(ago(8 * 24 * 3_600_000), NOW)).toBe("last week");
  });
});
