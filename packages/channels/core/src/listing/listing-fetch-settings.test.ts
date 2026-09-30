import { ScraperApiClient } from "@crawl-automation/platform";
import { afterEach, expect, it, vi } from "vitest";
import { ListingFetchSettingsSchema } from "./listing-fetch-settings.js";
import { createListingPages } from "./listing-pages-factory.js";

afterEach(() => vi.restoreAllMocks());

it("defaults any configured channel to no pause and accepts independent intervals", () => {
  const schema = ListingFetchSettingsSchema.shape.channels;
  expect(schema.parse(undefined)).toEqual({});
  expect(schema.parse({ gnc: { premium: true } })).toEqual({
    gnc: { premium: true, requestIntervalMs: 0 },
  });
  expect(
    schema.parse({ swanson: { requestIntervalMs: 3000 }, gnc: { requestIntervalMs: 10 } }),
  ).toEqual({ swanson: { requestIntervalMs: 3000 }, gnc: { requestIntervalMs: 10 } });
});

it.each([-1, 0.5, "3000", NaN, Infinity, 2_147_483_648])(
  "rejects invalid intervals: %s",
  (requestIntervalMs) => {
    expect(
      ListingFetchSettingsSchema.shape.channels.safeParse({ swanson: { requestIntervalMs } })
        .success,
    ).toBe(false);
  },
);

it("keeps pacing configuration out of ScraperAPI provider options", async () => {
  const failure = new Error("test stops before fetching");
  const get = vi.spyOn(ScraperApiClient.prototype, "get").mockRejectedValueOnce(failure);
  const origin = "https://example.com";
  const settings = ListingFetchSettingsSchema.parse({
    route: {
      routeId: "test",
      egressId: "test/1",
      version: "scraperapi/1",
      mode: "scraperapi",
      managed: true,
      countryCode: "us",
      sessionNumber: null,
      responseMode: "html",
      providerPolicy: "scraperapi-sync/1",
    },
    scraperApi: { apiKey: "test-key-0000", allowedOrigins: [origin] },
    channels: { swanson: { requestIntervalMs: 3000, premium: true } },
  });
  const pages = createListingPages(settings, {
    read: async () => null,
    create: async () => "created",
  });
  await expect(
    pages.read(
      {
        scanId: "scan",
        channel: "swanson",
        url: `${origin}/brand`,
        label: "page-1",
        answer: "html",
        origins: [origin],
        maxBytes: 1000,
      },
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  expect(get).toHaveBeenCalledOnce();
  expect(get.mock.calls[0]?.[0].options).toEqual({
    countryCode: "us",
    sessionNumber: null,
    render: false,
    premium: true,
  });
});
