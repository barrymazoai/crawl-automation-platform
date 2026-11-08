import { expect, it, vi } from "vitest";
import { amazonInSourceFromAmazon, amazonInSourceLookup } from "./amazon-in-source-derivation.js";
import { appWith, post } from "./testing/app-with.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const source = {
  sourceId,
  brandId: sourceId,
  brandName: "Himalaya USA",
  channel: "amazon",
  enabled: true,
};

it("builds the amazon.in Diet & Nutrition brand search from the amazon.com brand ID (owner 2026-11-08)", () => {
  expect(
    amazonInSourceFromAmazon({
      ...source,
      url: "https://www.amazon.com/s?k=Himalaya&i=hpc&rh=n%3A3760901%2Cp_123%3A94291&dc=",
    }),
  ).toBe(
    "https://www.amazon.in/s?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291&s=exact-aware-popularity-rank",
  );
});

it.each([
  "https://www.amazon.com/s?rh=p_123%3A94291",
  "https://www.amazon.com/s?rh=p_89%3AHimalaya",
  "https://www.amazon.com/stores/page/11111111-1111-4111-8111-111111111111",
  "https://www.amazon.com/s?rh=p_123%3A12%2Cp_123%3A13",
])("skips a source without one numeric brand ID and a keyword: %s", (url) => {
  expect(amazonInSourceFromAmazon({ ...source, url })).toBeNull();
});

it("only derives from amazon.com sources", () => {
  const url = "https://www.amazon.in/s?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291";
  expect(amazonInSourceFromAmazon({ ...source, channel: "amazon-in", url })).toBeNull();
});

it("validates the API input and returns the service counts", async () => {
  const deriveAmazonIn = vi.fn(async () => ({ created: 1, skipped: 0 }));
  const app = appWith({ brandSources: { deriveAmazonIn } });
  const input = { sourceIds: [sourceId] };
  const response = await app.request("/trpc/brands.deriveAmazonInSources", post(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { data: { created: 1, skipped: 0 } } });
  expect(deriveAmazonIn).toHaveBeenCalledWith(input);
});

it("looks a brand up on amazon.in by name from a source of any channel, one archived page per brand", async () => {
  const body = `<html><body><div id="brandsRefinements"><ul><li id="p_123/585714">
    <span class="a-size-base a-color-base">Redcon1</span></li></ul></div><div class="s-main-slot"></div></body></html>`;
  const read = vi.fn(async () => ({ body, archiveKey: "key", creditCost: 5, fromArchive: false }));
  const dtc = { ...source, brandName: "Redcon1", channel: "dtc", url: "https://redcon1.com/" };
  expect(await amazonInSourceLookup({ read })(dtc, new AbortController().signal)).toBe(
    "https://www.amazon.in/s?k=Redcon1&i=hpc&rh=n%3A1374489031%2Cp_123%3A585714&s=exact-aware-popularity-rank",
  );
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      scanId: "amazon-in-brand-lookup",
      label: `brand-${sourceId}`,
      channel: "amazon-in",
      url: "https://www.amazon.in/s?k=Redcon1&i=hpc&rh=n%3A1374489031&s=exact-aware-popularity-rank",
    }),
    expect.any(AbortSignal),
  );
});

it("validates the lookup input: at most 100 sources a call", async () => {
  const lookupAmazonIn = vi.fn(async () => ({
    created: 0,
    existing: 0,
    missing: 0,
    notFound: [],
    failed: [],
  }));
  const app = appWith({ brandSources: { lookupAmazonIn } });
  const many = { sourceIds: Array.from({ length: 101 }, () => sourceId) };
  expect((await app.request("/trpc/brands.lookupAmazonInSources", post(many))).status).toBe(400);
  const response = await app.request(
    "/trpc/brands.lookupAmazonInSources",
    post({ sourceIds: [sourceId] }),
  );
  expect(response.status).toBe(200);
  expect(lookupAmazonIn).toHaveBeenCalledWith({ sourceIds: [sourceId] }, expect.any(AbortSignal));
});
