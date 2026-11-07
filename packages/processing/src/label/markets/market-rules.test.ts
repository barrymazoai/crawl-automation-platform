import { describe, expect, it } from "vitest";
import { INDIA_RULES, US_RULES, marketRules } from "./market-rules.js";

describe("market label rules (owner 2026-11-07)", () => {
  it("a channel without label formats, or with the US formats only, is read with the US rules", () => {
    expect(marketRules(undefined)).toBe(US_RULES);
    expect(marketRules(["us-facts/1"])).toBe(US_RULES);
  });

  it("amazon.in's formats choose the India rules", () => {
    expect(marketRules(["us-facts/1", "in-nutritional-information/2", "in-composition/2"])).toBe(
      INDIA_RULES,
    );
  });

  it("the US rules change nothing: every panel and every check code is kept", () => {
    const codes = ["LABEL.INGREDIENT_BOUNDARY", "LABEL.COVERAGE_UNCERTAIN"];
    expect(US_RULES.textCodes({} as never, codes, "")).toEqual(codes);
    expect(US_RULES.copyPanels([{ heading: "Supplement Facts" } as never])).toHaveLength(1);
  });
});
