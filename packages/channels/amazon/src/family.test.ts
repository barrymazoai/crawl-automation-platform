import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { amazonAdapter } from "./index.js";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const fixture = savedPage(savedPaths.fish);

/** Change only the saved page's twister data, preserving the real product DOM and gallery. */
function withFamily(dimensions: string[], members: Record<string, string[]>) {
  const page = fixture.read();
  const document = parseHTML(page.html).document;
  document.querySelectorAll("script").forEach((script) => {
    if (script.textContent?.includes("dimensionValuesDisplayData")) {
      script.remove();
    }
  });
  const script = document.createElement("script");
  script.textContent = `var twister = ${JSON.stringify({
    parentAsin: "B0CWSXGT5V",
    dimensions,
    dimensionValuesDisplayData: members,
  })};`;
  document.body.append(script);
  return amazonAdapter.parseProduct({ ...page, html: document.toString() });
}

describe.skipIf(!fixture.available)(`${fixture.name}: variation dimensions`, () => {
  it("retains all observed ASINs and size labels for a size-only family", () => {
    const product = withFamily(["size_name"], {
      B0013LAQS6: ["120 Count"],
      B0013L5G9U: ["145 Count"],
      B074N9PY1Q: ["220 Count"],
    });
    expect(amazonAdapter.productFamily?.(product)).toEqual({
      differsBy: "size",
      group: "size name",
      selectedLabel: "120 Count",
      members: [
        {
          listingId: "B0013L5G9U",
          variantId: null,
          url: "https://www.amazon.com/dp/B0013L5G9U",
          label: "145 Count",
        },
        {
          listingId: "B074N9PY1Q",
          variantId: null,
          url: "https://www.amazon.com/dp/B074N9PY1Q",
          label: "220 Count",
        },
      ],
    });
  });

  it.each([
    ["size_name", ["120 Count (Pack of 1)", "120 Count (Pack of 2)"], "pack-count"],
    ["item_package_quantity", ["1", "2"], "pack-count"],
    ["flavor_name", ["Cherry", "Lemon"], "flavour"],
    ["size_name", ["100 mg", "200 mg"], "strength"],
    ["form", ["Tablet", "Powder"], "form"],
    ["style_name", ["120 Count", "240 Count"], "unknown"],
  ] as const)(
    "classifies %s without treating formula changes as sizes",
    (dimension, [own, other], expected) => {
      if (!own || !other) {
        throw new Error("Both option labels are required");
      }
      const product = withFamily([dimension], { B0013LAQS6: [own], B0013L5G9U: [other] });
      expect(amazonAdapter.productFamily?.(product)?.differsBy).toBe(expected);
    },
  );

  it("does not assume an unknown simultaneous dimension is safe", () => {
    const product = withFamily(["style_name", "size_name"], {
      B0013LAQS6: ["100 Count", "120 Count"],
      B0013L5G9U: ["200 Count", "240 Count"],
    });
    expect(amazonAdapter.productFamily?.(product)?.differsBy).toBe("unknown");
  });

  it("rejects unrelated maps that do not contain the page's own ASIN", () => {
    const product = withFamily(["size_name"], {
      B0013L5G9U: ["145 Count"],
      B074N9PY1Q: ["220 Count"],
    });
    expect(product.variants).toEqual([]);
    expect(amazonAdapter.productFamily?.(product)).toBeNull();
  });

  it("decodes escaped quotes and braces as part of the label", () => {
    const product = withFamily(["flavor_name"], {
      B0013LAQS6: ['Cherry "Original" {red}'],
      B0013L5G9U: ["Lemon / Lime"],
    });
    expect(amazonAdapter.productFamily?.(product)?.selectedLabel).toBe('Cherry "Original" {red}');
    expect(product.variants).toHaveLength(1);
  });
});
