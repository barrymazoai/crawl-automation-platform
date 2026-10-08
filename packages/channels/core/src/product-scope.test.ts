import { describe, expect, it } from "vitest";
import { jsonLdBreadcrumbs, nonSupplementPath } from "./product-scope.js";

describe("store categories (owner 2026-10-08)", () => {
  it("reads a JSON-LD breadcrumb in position order and skips blocks that do not parse", () => {
    const list = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 2, name: "Equipment & Accessories" },
        { "@type": "ListItem", position: 1, item: { name: "Shop" } },
      ],
    };
    expect(jsonLdBreadcrumbs(["{ broken", JSON.stringify({ "@graph": [list] })])).toEqual([
      "Shop",
      "Equipment & Accessories",
    ]);
    expect(jsonLdBreadcrumbs([JSON.stringify({ "@type": "Product" })])).toEqual([]);
  });

  it("applies only when one breadcrumb name is a category the channel files outside supplements", () => {
    const outside = ["Baby Products", "Beauty & Personal Care"];
    expect(nonSupplementPath(["Baby Products", "Diapering"], outside)).toEqual([
      "Baby Products",
      "Diapering",
    ]);
    expect(
      nonSupplementPath(["Health & Household", "Vitamins, Minerals & Supplements"], outside),
    ).toBeNull();
    expect(nonSupplementPath(undefined, outside)).toBeNull();
    expect(nonSupplementPath(["Baby Products"], undefined)).toBeNull();
  });
});
