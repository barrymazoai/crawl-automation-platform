import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { listingDateDelivery, labelExtras, labelListing } from "./listing-date.js";
import { salesEstimateDelivery } from "./sales-estimate.js";
import { deliveryLabel } from "./label-mapping.js";
import type { DeliveryItem } from "./wire.js";

const date = {
  date: "2025-10-13",
  rawText: "Date First Available ‏ : ‎ October 13, 2025",
  selector: "#detailBullets_feature_div li" as const,
};

it("resync preserves the complete prior label request, including its idempotency keys", () => {
  const collection = LabelCollectedProductSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../adapters/src/postgres/fixtures/collected-product.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const item: DeliveryItem = {
    clientRef: "saved-ref",
    domain: "matched.example",
    capturedAt: "2026-09-23T00:00:00Z",
    externalId: "B0013LAQS6",
    sourceUrl: "https://www.amazon.com/dp/B0013LAQS6",
    productUrl: "https://www.amazon.com/dp/B0013LAQS6",
    productName: "Saved title",
    titleRaw: "Saved title",
    attrsRaw: {},
    images: [],
    extras: { commerce: { price: "9.99" } },
  };
  const context = { collection, channel: "amazon" as const, company: { domain: item.domain } };
  const before = deliveryLabel({ ...context, item });
  const after = {
    ...item,
    ...listingDateDelivery({
      channel: "amazon",
      metrics: { extras: item.extras },
      dateFirstAvailable: date,
    }),
  };
  expect(after.listedAt).toBe("2025-10-13T12:00:00.000Z");
  expect(deliveryLabel({ ...context, item: after })).toEqual(before);
  // The units estimate and the reparsed rank reach the observation item only (KAN-226).
  const estimated = {
    ...after,
    ...salesEstimateDelivery({
      channel: "amazon",
      metrics: { extras: item.extras },
      siblings: 0,
      salesRank: {
        rank: 5_218,
        category: "Health & Household",
        rawText: "#5,218 in Health & Household (See Top 100 in Health & Household)",
        selector: "#detailBullets_feature_div li",
      },
      extras: after.extras,
    }),
  };
  expect(estimated).toMatchObject({
    salesRank: 5_218,
    unitsSold: 5_617,
    unitsSoldPeriod: "trailing_30d",
  });
  expect(deliveryLabel({ ...context, item: estimated })).toEqual(before);
});

it("the label listing keeps a page badge's units and drops every estimate, rank and other channels' nothing", () => {
  const badge = {
    extras: {
      commerce: { price: "9.99", salesRank: { rank: 1 } },
      salesEstimate: { source: "badge", units: 500 },
    },
    salesRank: 1,
    unitsSold: 500,
    unitsSoldPeriod: "trailing_30d",
  };
  expect(labelListing("amazon", badge)).toEqual({
    extras: { commerce: { price: "9.99" } },
    unitsSold: 500,
    unitsSoldPeriod: "trailing_30d",
  });
  const floor = {
    ...badge,
    extras: { ...badge.extras, salesEstimate: { source: "floor", units: 25 } },
  };
  expect(labelListing("amazon", floor)).toEqual({ extras: { commerce: { price: "9.99" } } });
  const gnc = { extras: { commerce: { price: "9.99" } }, unitsSold: 7, unitsSoldPeriod: "monthly" };
  expect(labelListing("gnc", gnc)).toBe(gnc);
});

it("new captures and retained-original reparses produce the same listing date without rewriting metrics", () => {
  const old = { extras: { commerce: { price: "9.99" } } };
  const current = { extras: { commerce: { ...old.extras.commerce, dateFirstAvailable: date } } };
  const parsed = listingDateDelivery({ channel: "amazon", metrics: current });
  const reparsed = listingDateDelivery({
    channel: "amazon",
    metrics: old,
    dateFirstAvailable: date,
  });
  for (const item of [parsed, reparsed]) {
    expect(item).toMatchObject({
      listedAt: "2025-10-13T12:00:00.000Z",
      listedAtSource: "amazon_dfa",
      extras: { amazonDfa: date },
    });
    expect(labelExtras("amazon", item.extras)).toEqual(old.extras);
  }
  expect(old.extras.commerce).toEqual({ price: "9.99" });
});

it("unavailable originals cannot reuse a date from metrics or emit an amazonDfa extra", () => {
  const commerce = { price: "9.99", dateFirstAvailable: date };
  const mapped = listingDateDelivery({
    channel: "amazon",
    metrics: { extras: { commerce, amazonDfa: date } },
    dateFirstAvailableWarning: { reason: "missing" },
  });
  expect(mapped).toEqual({ extras: { commerce } });
});

it.each([null, { ...date, date: null }])(
  "missing or unrecognised DFA %j stays optional",
  (missing) => {
    const item = listingDateDelivery({
      channel: "amazon",
      metrics: {},
      dateFirstAvailable: missing,
    });
    expect(item).not.toHaveProperty("listedAt");
    expect(item).not.toHaveProperty("listedAtSource");
    expect(item.extras).toEqual({ amazonDfa: missing });
    expect(labelExtras("amazon", item.extras)).toEqual({});
  },
);

it.each(["dtc", "gnc", "swanson", "wholefoods", "costco"])(
  "%s never receives Amazon listedAt",
  (channel) => {
    const metrics = { extras: { commerce: { dateFirstAvailable: date } } };
    expect(listingDateDelivery({ channel, metrics, dateFirstAvailable: date })).toEqual({
      extras: metrics.extras,
    });
    expect(labelExtras(channel, metrics.extras)).toEqual(metrics.extras);
  },
);

it.each([
  "America/Los_Angeles",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Asia/Shanghai",
])("noon UTC displays the calendar date in %s", (timeZone) => {
  const item = listingDateDelivery({ channel: "amazon", metrics: {}, dateFirstAvailable: date });
  const instant = new Date(String("listedAt" in item ? item.listedAt : ""));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  expect(formatter.format(instant)).toBe(date.date);
});
