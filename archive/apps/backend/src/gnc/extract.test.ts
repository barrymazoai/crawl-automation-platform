import { describe, expect, it } from "vitest";
import { extractGncProduct, variantUrls, type RawGncPage } from "./extract.js";

const page: RawGncPage = {
  url: "https://www.gnc.com/whey-protein/379969.html",
  title: "GNC product",
  diagnosticText: "GNC product page",
  capturedAt: "2026-08-28T00:00:00.000Z",
  denied: false,
  product: {
    "@type": "Product",
    name: "100% Whey 2.0 - Vanilla Cream (64 Servings)",
    sku: "379969",
    mpn: "048107252779",
    brand: { name: "GNC Pro Performance®" },
    image: ["https://img.example/front.jpg"],
    aggregateRating: { ratingValue: "4.0", reviewCount: "123" },
  },
  group: {
    "@type": "ProductGroup",
    name: "100% Whey Protein Powder V2",
    productGroupID: "gnc-pro-performance-whey-v2",
    hasVariant: [{
      "@type": "Product",
      name: "100% Whey 2.0 - Vanilla Cream (64 Servings)",
      sku: "379969",
      mpn: "048107252779",
      flavor: "Vanilla Cream",
      size: "64",
      offers: { url: "https://www.gnc.com/whey-protein/379969.html", price: 119.99, priceCurrency: "USD", availability: "http://schema.org/InStock" },
    }],
  },
  analytics: { item_id: "379969", item_brand: "GNC Pro Performance®", size: "4 (lb)", flavor: "Vanilla Cream", item_primaryCategory: "Whey Protein" },
  variantUrls: ["/whey-protein/379970.html"],
  pdfLinks: ["https://www.gnc.com/library/pdf/379969_lbl.pdf"],
  imageUrls: [],
  detailText: "25g protein. Ingredients and directions.",
  factsText: "Supplement Facts. Serving Size 1 Scoop.",
};

describe("GNC extraction", () => {
  it("uses the explicit SKU and maps the selected variant", () => {
    expect(extractGncProduct(page)).toMatchObject({
      sku: "379969",
      mpn: "048107252779",
      price: "119.99",
      currency: "USD",
      inStock: true,
      labelPdfUrl: "https://www.gnc.com/library/pdf/379969_lbl.pdf",
      family: { parentExternalId: "gnc-pro-performance-whey-v2" },
      variantAttrs: { flavor: "Vanilla Cream", size: "4 (lb)", servings: "64", upc: "048107252779" },
      factsText: "Supplement Facts. Serving Size 1 Scoop.",
      capturedAt: "2026-08-28T00:00:00.000Z",
    });
  });

  it("combines ProductGroup and fixed DOM variation links", () => {
    expect(variantUrls(page)).toEqual([
      "https://www.gnc.com/whey-protein/379969.html",
      "https://www.gnc.com/whey-protein/379970.html",
    ]);
  });
});
