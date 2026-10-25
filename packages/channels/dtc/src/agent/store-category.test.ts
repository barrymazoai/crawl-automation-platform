import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { pageBreadcrumbs, readShopifyData } from "@crawl-automation/channels-core";
import { neverCollectPath } from "../adapter.js";
import { dtcSitePolicy } from "../site-policy.js";
import { neverCollectFromHtml } from "./never-collect.js";
import { scopedOutcome } from "./product-scope.js";

const corpus = new URL("../../../../../tools/diag-corpus/round9/dherbs/pages/", import.meta.url);
const source = { objectKey: "retained/original.html", sha256: "a".repeat(64), byteSize: 120 };
const identity = { listingId: "dherbs-product", variantId: null };
const site = dtcSitePolicy({
  siteKey: "www.dherbs.com",
  platform: "custom",
  catalogUrl: "https://www.dherbs.com/store/",
});

const expected = [
  ["alkaline-formula-p-596", "model-scope"],
  ["antiaging-formula-p-638", "model-scope"],
  ["antiv-formula-p-6", "model-scope"],
  ["black-seed-rooibos-tea-p-248", "not-collected"],
  ["cellulite-oil-4-oz-p-371", "skip-scope-for-label"],
  ["detox-formula-p-646", "model-scope"],
  ["female-breast-formula-p-30", "model-scope"],
  ["female-health-tea-p-242", "not-collected"],
  ["full-body-cleanse-companion-ebook-p-227", "not-collected"],
  ["garcinia-cambogia-p-254", "model-scope"],
  ["gift-certificate-50-p-602", "not-collected"],
  ["joint-aid-tea-p-280", "not-collected"],
  ["male-hormonal-formula-p-46", "model-scope"],
  ["nervecalming-tea-p-237", "not-collected"],
  ["nerves-cleanse-regimen-p-486", "bundle"],
  ["passion-inhaler-p-124", "not-collected"],
  ["sea-moss-combo-p-835", "model-scope"],
  ["soothing-tea-p-449", "not-collected"],
  ["the-i-can-home-challenge-p-736", "bundle"],
  ["weight-release-inhaler-p-268", "not-collected"],
] as const;

it.each(expected)("%s: retained breadcrumb routes to %s", async (name, route) => {
  const html = readFileSync(new URL(`${name}.html`, corpus), "utf8");
  const categories = pageBreadcrumbs(parseHTML(html).document);
  expect(categories[0]).toBe("Home");
  const skipped = neverCollectFromHtml({
    html: Buffer.from(html),
    url: `https://www.dherbs.com/store/${name}.html`,
    site,
    operationId: name,
  });
  if (route === "not-collected") {
    expect(skipped).toMatchObject({
      status: "not-supplement",
      reason: "PRODUCT.NOT_SUPPLEMENT",
      categories,
      reviewCode: null,
    });
    return;
  }
  expect(skipped).toBeNull();
  const review = vi.fn(async () => ({
    decision: { kind: "single_product" as const, reason: "single", evidence: [], components: [] },
    evidence: source,
  }));
  const outcome = await scopedOutcome({ categories, source, operationId: name, identity }, review);
  if (route === "bundle") {
    expect(outcome).toMatchObject({
      status: "scope-excluded",
      reason: "DTC.MULTI_PRODUCT_BUNDLE",
      categories,
    });
  } else {
    expect(outcome).toBeNull();
  }
  expect(review).toHaveBeenCalledTimes(route === "model-scope" ? 1 : 0);
});

it.each([
  ["Bath Drops (Essential Oil)", "not-supplement"],
  ["Beauty", null],
])("ends %s at capture only when its category is clear", (category, status) => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "BreadcrumbList",
    itemListElement: ["Home", category, "Sample"].map((name, index) => ({
      position: index + 1,
      name,
    })),
  })}</script>`;
  expect(
    neverCollectFromHtml({
      html: Buffer.from(html),
      url: "https://www.dherbs.com/store/sample-p-1.html",
      site,
      operationId: "sample",
    })?.status ?? null,
  ).toBe(status);
});

it("uses the own Shopify product type before projection without treating tags as store type", () => {
  const shopifySite = dtcSitePolicy({
    siteKey: "shop.example",
    platform: "shopify",
    catalogUrl: "https://shop.example/collections/all",
  });
  const record = {
    id: 123,
    handle: "sample",
    title: "Sample",
    variants: [{ id: 456 }],
    product_type: "Aroma Spray",
    tags: ["Beauty"],
  };
  const html = `<script type="application/json">${JSON.stringify(record)}</script>`;
  expect(
    neverCollectFromHtml({
      html: Buffer.from(html),
      url: "https://shop.example/products/sample",
      site: shopifySite,
      operationId: "shopify-sample",
    }),
  ).toMatchObject({ status: "not-supplement", categories: ["Aroma Spray"] });
});

it("uses Shopify product type but ignores a free-form Teas tag", () => {
  const record = {
    id: 123,
    handle: "sample",
    title: "Sample",
    variants: [{ id: 456 }],
    product_type: "Supplements",
    tags: ["Teas"],
  };
  const parsed = readShopifyData(record, "https://example.test/products/sample");
  expect(parsed.categories).toContain("Teas");
  expect(neverCollectPath([], parsed.storeType)).toBeNull();
  expect(neverCollectPath([], "tEaS")).toEqual(["tEaS"]);
  expect(neverCollectPath(["Home", "Supplements", "Teas"])).toBeNull();
  expect(neverCollectPath(["Home", "Teas", "Sample"], parsed.storeType)).toEqual([
    "Home",
    "Teas",
    "Sample",
  ]);
});
