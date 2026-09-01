import { describe, expect, it } from "vitest";
import { coverForId } from "./cover";

/**
 * Pinned outputs of the current hash, obtained by running `coverForId` itself
 * over these ids — not derived by hand.
 *
 * The property that matters is stability ACROSS RESTARTS: a book must keep its
 * colour forever. Calling the function twice in one process cannot see that
 * break, because the only thing that breaks it is someone changing the hash.
 * These goldens do see it: any change to the algorithm reshuffles at least one
 * of them and fails here loudly. The five ids happen to cover all five
 * palettes, so a change to `PALETTES` fails here too.
 *
 * If this test fails, the fix is almost never to update the values — it is to
 * put the hash back. Changing them silently recolours every existing library.
 */
const GOLDEN: [string, string][] = [
  ["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "warm"],
  ["9c858901-8a57-4791-81fe-4c455b099bc9", "amber"],
  ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", "slate"],
  ["00000000-0000-0000-0000-000000000000", "rose"],
  ["16fd2706-8baf-433b-82eb-8c7fada847da", "teal"],
];

describe("coverForId", () => {
  it.each(GOLDEN)("maps %s to the %s palette", (id, palette) => {
    expect(coverForId(id)).toBe(palette);
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
