import { describe, expect, it } from "vitest";
import { coverForId } from "./cover";

describe("coverForId", () => {
  it("is stable for the same id", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(coverForId(id)).toBe(coverForId(id));
  });

  it("always returns a known palette", () => {
    const known = ["warm", "teal", "rose", "amber", "slate"];
    for (let i = 0; i < 200; i++) {
      expect(known).toContain(coverForId(`id-${i}`));
    }
  });

  it("spreads ids across more than one palette", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => coverForId(`id-${i}`)));
    expect(seen.size).toBeGreaterThan(1);
  });
});
