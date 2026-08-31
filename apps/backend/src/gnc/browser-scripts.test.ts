import { describe, expect, it } from "vitest";
import { GNC_DISCOVERY_SCRIPT, GNC_PRODUCT_SCRIPT, isGncAccessChallenge } from "./capture.js";

describe("GNC fixed browser scripts", () => {
  it.each([GNC_DISCOVERY_SCRIPT, GNC_PRODUCT_SCRIPT])("is valid JavaScript", (script) => {
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it("keeps catalog and PDP extraction deterministic", () => {
    expect(GNC_DISCOVERY_SCRIPT).toContain("data-grid-url");
    expect(GNC_DISCOVERY_SCRIPT).toContain("expectedCount");
    expect(GNC_PRODUCT_SCRIPT).toContain("pathSku");
    expect(GNC_PRODUCT_SCRIPT).toContain("variantUrls");
    expect(GNC_PRODUCT_SCRIPT).toContain("capturedAt");
    expect(GNC_PRODUCT_SCRIPT).toContain("#productDetailsAccordionContent");
    expect(GNC_PRODUCT_SCRIPT).toContain("#productIngredientsAccordionContent");
    expect(GNC_PRODUCT_SCRIPT).toContain("HTML FACTS TABLE");
  });

  it("classifies HTTP 406 as a PerimeterX challenge even when page text is opaque", () => {
    expect(isGncAccessChallenge(406, false)).toBe(true);
    expect(isGncAccessChallenge(200, true)).toBe(true);
    expect(isGncAccessChallenge(200, false)).toBe(false);
  });
});
