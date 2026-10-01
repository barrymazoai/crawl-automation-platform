import { CommerceEvidenceSchema } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const samples = [
  {
    path: savedPaths.fishLater,
    postalCode: "14205",
    sales: { lowerBound: "1000", period: "past_month", approximate: true },
  },
  {
    path: savedPaths.manganese,
    postalCode: "19103",
    sales: null,
  },
  { path: savedPaths.vitamin, postalCode: "19103", sales: null },
];

for (const sample of samples) {
  const fixture = savedPage(sample.path);
  describe.skipIf(!fixture.available)(`retained commerce: ${fixture.name}`, () => {
    it("recovers sales claims and offer/location context from the unchanged original", () => {
      const root = productRoot(amazonDocument(fixture.read().html));
      const commerce = CommerceEvidenceSchema.parse(amazonCommerce(root, fixture.asin));
      expect(commerce.purchaseConditions?.delivery).toMatchObject({
        postalCode: sample.postalCode,
        countryCode: null,
      });
      expect(commerce.context.some((text) => text.includes(sample.postalCode))).toBe(true);
      if (sample.sales) {
        expect(commerce.salesVolume).toMatchObject(sample.sales);
      } else {
        expect(commerce.salesVolume).toBeNull();
      }
      expect(commerce.purchaseConditions?.evidence.length).toBeGreaterThan(0);
      if (sample.path === savedPaths.fishLater) {
        expect(commerce.purchaseConditions).toMatchObject({
          purchaseType: "one_time",
          priceScope: "selected_offer",
          seller: { name: "Amazon.com" },
          shipsFrom: "Amazon.com",
        });
      }
      expect(commerce).not.toHaveProperty("salesRank");
    });
  });
}
