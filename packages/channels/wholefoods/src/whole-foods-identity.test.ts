import { expect, it } from "vitest";
import { wholeFoodsPageIdentity } from "./whole-foods-identity.js";
import { wholeFoodsAdapter } from "./whole-foods-adapter.js";
import { WHOLE_FOODS_STORE } from "./whole-foods-store.js";
import { syntheticIdentity } from "./identity-fixture.js";

const page = (html: string) => ({
  url: "https://www.wholefoodsmarket.com/grocery/product/x-b002cqu54q",
  html,
  capturedAt: "2026-10-01T00:00:00Z",
});
it.each([
  { product: { asin: "b0096m5pbw" }, storePreference: { buid: "10259" } },
  { pageData: { product: { asin: "B0096M5PBW" } } },
  {
    props: {
      pageProps: { product: { asin: "B0096M5PBW" }, recommendations: [{ asin: "B002CQU54Q" }] },
    },
  },
  // The real page shape: the selected product in aapiData, other sizes only in its variationsList.
  {
    props: {
      pageProps: {
        aapiData: { asin: "B0096M5PBW", variationsList: [{ asin: "B002CQU54Q" }] },
        storeDetailsInitialData: { storeId: "10259" },
      },
    },
  },
])("reads only explicit selected-product data: %j", (data) => {
  const html = `<script type="application/json">${JSON.stringify(data)}</script>`;
  expect(wholeFoodsPageIdentity(page(html))).toEqual({ listingId: "B0096M5PBW", variantId: null });
});
it.each([
  '<link rel="canonical" href="https://www.wholefoodsmarket.com/grocery/product/x-b0096m5pbw">',
  '<script type="application/json">{"asin":"B002CQU54Q","recommendations":[{"asin":"B0096M5PBW"}]}</script>',
  '<script type="application/json">{broken</script>',
  syntheticIdentity() + syntheticIdentity("B002CQU54Q"),
])("refuses missing or ambiguous page identity: %s", (html) => {
  expect(wholeFoodsPageIdentity(page(html))).toBeNull();
  expect(() => wholeFoodsAdapter(WHOLE_FOODS_STORE).parseProduct(page(html))).toThrow(
    expect.objectContaining({ code: "WHOLEFOODS.PRODUCT_UNVERIFIED" }),
  );
});
