import { describe, expect, it } from "vitest";
import { relativeTime } from "./time";

const NOW = new Date("2026-09-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

// These assert the calendar bucketing only. Wording and plural forms moved to
// the catalogue, so asserting English sentences here would test the English
// translation rather than the logic this module still owns.
describe("relativeTime", () => {
  it("reports seconds as just now", () => {
    expect(relativeTime(ago(30_000), NOW)).toEqual({ key: "justNow" });
  });

  it("counts minutes, singular and plural alike", () => {
    expect(relativeTime(ago(60_000), NOW)).toEqual({ key: "minutesAgo", count: 1 });
    expect(relativeTime(ago(5 * 60_000), NOW)).toEqual({ key: "minutesAgo", count: 5 });
  });

  it("reports hours", () => {
    expect(relativeTime(ago(2 * 3_600_000), NOW)).toEqual({ key: "hoursAgo", count: 2 });
  });

  it("reports one day as yesterday", () => {
    expect(relativeTime(ago(25 * 3_600_000), NOW)).toEqual({ key: "yesterday" });
  });

  it("reports one week as last week", () => {
    expect(relativeTime(ago(8 * 24 * 3_600_000), NOW)).toEqual({ key: "lastWeek" });
  });

  it("reports multiple weeks", () => {
    expect(relativeTime(ago(21 * 24 * 3_600_000), NOW)).toEqual({ key: "weeksAgo", count: 3 });
  });
});
