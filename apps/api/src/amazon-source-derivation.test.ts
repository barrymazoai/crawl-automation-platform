import { AMAZON_IN, AMAZON_UK } from "@crawl-automation/channel-amazon";
import { expect, it, vi } from "vitest";
import { amazonSourceFromAmazon, amazonSourceLookup } from "./amazon-source-derivation.js";
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
    amazonSourceFromAmazon(AMAZON_IN)({
      ...source,
      url: "https://www.amazon.com/s?k=Himalaya&i=hpc&rh=n%3A3760901%2Cp_123%3A94291&dc=",
    }),
  ).toBe(
    "https://www.amazon.in/s?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291&s=exact-aware-popularity-rank",
  );
});

it("builds the amazon.co.uk Vitamins, Minerals & Supplements brand search the same way (owner 2026-11-10)", () => {
  expect(
    amazonSourceFromAmazon(AMAZON_UK)({
      ...source,
      url: "https://www.amazon.com/s?k=Himalaya&i=hpc&rh=n%3A3760901%2Cp_123%3A94291&dc=",
    }),
  ).toBe(
    "https://www.amazon.co.uk/s?k=Himalaya&i=hpc&rh=n%3A2826484031%2Cp_123%3A94291&s=exact-aware-popularity-rank",
  );
});

it.each([
  "https://www.amazon.com/s?rh=p_123%3A94291",
  "https://www.amazon.com/s?rh=p_89%3AHimalaya",
  "https://www.amazon.com/stores/page/11111111-1111-4111-8111-111111111111",
  "https://www.amazon.com/s?rh=p_123%3A12%2Cp_123%3A13",
])("skips a source without one numeric brand ID and a keyword: %s", (url) => {
  expect(amazonSourceFromAmazon(AMAZON_IN)({ ...source, url })).toBeNull();
});

it("only derives from amazon.com sources", () => {
  const url = "https://www.amazon.in/s?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291";
  expect(amazonSourceFromAmazon(AMAZON_UK)({ ...source, channel: "amazon-in", url })).toBeNull();
});

it("validates the API input and passes the storefront to the service", async () => {
  const deriveAmazon = vi.fn(async () => ({ created: 1, skipped: 0 }));
  const app = appWith({ brandSources: { deriveAmazon } });
  const input = { channel: "amazon-uk", sourceIds: [sourceId] };
  const response = await app.request("/trpc/brands.deriveAmazonSources", post(input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { data: { created: 1, skipped: 0 } } });
  expect(deriveAmazon).toHaveBeenCalledWith(input);
  for (const channel of ["amazon", "gnc", undefined]) {
    const refused = await app.request(
      "/trpc/brands.deriveAmazonSources",
      post({ channel, sourceIds: [sourceId] }),
    );
    expect(refused.status).toBe(400);
  }
});

it("looks a brand up on a storefront by name from a source of any channel, one archived page per brand", async () => {
  const body = `<html><body><div id="brandsRefinements"><ul><li id="p_123/585714">
    <span class="a-size-base a-color-base">Redcon1</span></li></ul></div><div class="s-main-slot"></div></body></html>`;
  const read = vi.fn(async () => ({ body, archiveKey: "key", creditCost: 5, fromArchive: false }));
  const dtc = { ...source, brandName: "Redcon1", channel: "dtc", url: "https://redcon1.com/" };
  expect(await amazonSourceLookup({ read }, AMAZON_IN)(dtc, new AbortController().signal)).toBe(
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
  expect(await amazonSourceLookup({ read }, AMAZON_UK)(dtc, new AbortController().signal)).toBe(
    "https://www.amazon.co.uk/s?k=Redcon1&i=hpc&rh=n%3A2826484031%2Cp_123%3A585714&s=exact-aware-popularity-rank",
  );
  expect(read).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scanId: "amazon-uk-brand-lookup",
      channel: "amazon-uk",
      origins: ["https://www.amazon.co.uk"],
      url: "https://www.amazon.co.uk/s?k=Redcon1&i=hpc&rh=n%3A2826484031&s=exact-aware-popularity-rank",
    }),
    expect.any(AbortSignal),
  );
});

it("validates the lookup input: a storefront and at most 100 sources a call", async () => {
  const lookupAmazon = vi.fn(async () => ({
    created: 0,
    existing: 0,
    missing: 0,
    notFound: [],
    failed: [],
  }));
  const app = appWith({ brandSources: { lookupAmazon } });
  const many = { channel: "amazon-uk", sourceIds: Array.from({ length: 101 }, () => sourceId) };
  expect((await app.request("/trpc/brands.lookupAmazonSources", post(many))).status).toBe(400);
  const input = { channel: "amazon-uk", sourceIds: [sourceId] };
  const response = await app.request("/trpc/brands.lookupAmazonSources", post(input));
  expect(response.status).toBe(200);
  expect(lookupAmazon).toHaveBeenCalledWith(input, expect.any(AbortSignal));
});
