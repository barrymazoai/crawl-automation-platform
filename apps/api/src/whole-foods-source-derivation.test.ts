import { expect, it, vi } from "vitest";
import { wholeFoodsSourceFromAmazon } from "./whole-foods-source-derivation.js";
import { appWith, post } from "./testing/app-with.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const source = {
  sourceId,
  brandId: sourceId,
  brandName: "Example Brand",
  channel: "amazon",
  enabled: false,
};

it("builds a Whole Foods source through its own URL builder from a category-scoped p_123", () => {
  expect(
    wholeFoodsSourceFromAmazon({
      ...source,
      url: "https://www.amazon.com/s?rh=n%3A3760901%2Cp_123%3A263310",
    }),
  ).toBe("https://www.wholefoodsmarket.com/grocery/search?k=Example+Brand&rh=p_123%3A263310");
});

it.each([
  "https://www.amazon.com/s?rh=p_6%3A263310",
  "https://www.amazon.com/s?rh=p_89%3AExample",
  "https://www.amazon.com/stores/page/11111111-1111-4111-8111-111111111111",
  "https://www.amazon.com.example.test/s?rh=p_123%3A263310",
  "https://www.amazon.com/s?k=Example",
  "https://www.amazon.com/s?rh=p_123%3A12%2Cp_123%3A13",
])("skips a source without one numeric brand ID: %s", (url) => {
  expect(wholeFoodsSourceFromAmazon({ ...source, url })).toBeNull();
});

it("validates the new API input and returns the service counts", async () => {
  const deriveWholeFoods = vi.fn(async () => ({ created: 1, skipped: 0 }));
  const app = appWith({ brandSources: { deriveWholeFoods } });
  const input = { sourceIds: [sourceId] };
  const response = await app.request("/trpc/brands.deriveWholeFoodsSources", post(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { data: { created: 1, skipped: 0 } } });
  expect(deriveWholeFoods).toHaveBeenCalledWith(input);
  const invalid = await app.request(
    "/trpc/brands.deriveWholeFoodsSources",
    post({ sourceIds: [] }),
  );
  expect(invalid.status).toBe(400);
  expect(deriveWholeFoods).toHaveBeenCalledOnce();
});
