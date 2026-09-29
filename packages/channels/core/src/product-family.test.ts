import { describe, expect, it } from "vitest";
import { classifyFamily } from "./product-family.js";

describe("what a product family differs by", () => {
  it.each([
    ["Size", ["60 Veg Caps", "120 Veg Caps"], "size"],
    ["Size", ["10.6 oz Pwdr", "21.2 oz Pwdr"], "size"],
    ["Count", ["30 Softgels", "90 Softgels"], "size"],
    ["Size", ["60 Caps", "2-Pack"], "pack-count"],
    ["Size", ["100 mg 60 Caps", "200 mg 60 Caps"], "strength"],
    ["Flavor", ["Chocolate", "Vanilla"], "flavour"],
    ["Form", ["Capsule", "Gummy"], "form"],
    ["Size", ["Small", "Large"], "unknown"],
    ["Size", ["60 Caps", "Chocolate"], "unknown"],
  ])("%s %j → %s", (group, labels, expected) => {
    expect(classifyFamily(group, labels)).toBe(expected);
  });
});
