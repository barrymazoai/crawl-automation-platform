import { describe, expect, it } from "vitest";
import { sameServingSize } from "./serving-size.js";

describe("serving sizes (owner 2026-10-08)", () => {
  it("treats format-only differences seen on Swanson pages as the same", () => {
    for (const [page, label] of [
      ["1 cup 245 g", "1 cup (245g)"],
      ["2 Drops", "2 drops"],
      ["2 grams (approx. 1 tsp)", "2.0 grams (approx 1 tsp)"],
      ["1/2 Tbsp. (11 g)", "1/2 Tbsp. (11g)"],
      ["1 Level Scoop", "1 level scoop (5 g)"],
    ] as const) {
      expect(sameServingSize(page, label)).toBe(true);
    }
  });

  it("treats a (s) plural marker, plural units and spelled-out counts as the same (GNC, owner 2026-10-09)", () => {
    for (const [page, label] of [
      ["2 Caplet(s)", "Two Caplets"],
      ["1 Scoop(s)", "1 Scoop (22g)"],
      ["2 Capsule(s)", "2 capsules"],
      ["1 Gummy", "1 gummies"],
      ["1 box", "1 boxes"],
      ["1 glass", "1 glasses"],
      ["2 doses", "2 dose"],
    ] as const) {
      expect(sameServingSize(page, label)).toBe(true);
    }
    expect(sameServingSize("2 Caplet(s)", "Three Caplets")).toBe(false);
  });

  it("keeps a different count or amount as a difference", () => {
    expect(sameServingSize("1 capsule", "2 capsules")).toBe(false);
    expect(sameServingSize("1 Scoop (Approx. 1 g)", "1 Scoop (Approx. 19g)")).toBe(false);
    expect(sameServingSize("1 scoop (25 g)", "1 scoop (30 g)")).toBe(false);
    expect(sameServingSize("1", "1 scoop")).toBe(false);
  });
});
