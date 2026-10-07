import { describe, expect, it } from "vitest";
import { swansonVariantChoices } from "./swanson-variants.js";

const base = "https://www.swansonvitamins.com/p/";
const own = "biochem-vegan-protein-powder-vanilla-15-3-oz-pwdr";

function page(options: object[], unmapped = 0) {
  return {
    url: `${base}${own}`,
    canonicalUrl: `${base}${own}`,
    title: "BioChem Vegan Protein Powder Vanilla",
    capturedAt: "2026-10-07T00:00:00.000Z",
    selectedForms: [{ productId: "1", variantIds: ["111"] }],
    gallery: [],
    sections: [],
    variantPicker: { unmapped, options },
  };
}

const option = (spec: {
  group: string;
  handle: string;
  variantId: string;
  selected?: boolean;
}) => ({
  group: spec.group,
  label: `${spec.group} ${spec.variantId}`,
  url: `${base}${spec.handle}`,
  variantId: spec.variantId,
  selected: spec.selected ?? false,
  available: true,
});

describe("Swanson pickers that only link sibling pages (owner 2026-10-07)", () => {
  it("treats a Flavor + Size picker as this one product", () => {
    const result = swansonVariantChoices(
      page([
        option({ group: "Flavor", handle: own, variantId: "111", selected: true }),
        option({ group: "Size", handle: own, variantId: "111", selected: true }),
        option({
          group: "Size",
          handle: "biochem-vegan-protein-powder-vanilla-22-8-oz-pwdr",
          variantId: "222",
        }),
      ]),
    );
    expect(result).toEqual({
      coverage: "selected-only",
      choices: [expect.objectContaining({ handle: own, variantId: "111" })],
    });
  });

  it("treats options without a variant ID as links, not a Review", () => {
    const result = swansonVariantChoices(
      page([option({ group: "Size", handle: own, variantId: "111", selected: true })], 1),
    );
    expect(result.coverage).toBe("selected-only");
    expect(result.choices).toHaveLength(1);
    expect(swansonVariantChoices(page([], 2)).coverage).toBe("selected-only");
  });

  it("still sends a selected option naming another product to Review", () => {
    expect(() =>
      swansonVariantChoices(
        page(
          [
            option({
              group: "Flavor",
              handle: "biochem-vegan-protein-powder-chocolate",
              variantId: "333",
              selected: true,
            }),
          ],
          1,
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "SWANSON.VARIANT_CONFLICT" }));
  });
});
