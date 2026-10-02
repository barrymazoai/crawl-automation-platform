import { expect, it } from "vitest";
import { readPlatformCatalog } from "@crawl-automation/channels-core";
import { dtcDocument } from "./product.js";
import { dtcSitePolicy } from "./site-policy.js";

const site = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "shopify",
  catalogUrl: "https://shop.example/collections/all",
});
const policy = { ...site.catalog, url: site.catalogUrl ?? "" };
const product = '<div id="product-grid"><a href="/products/zinc">Zinc</a></div>';

it("excludes explicitly marked score badges while preserving real external product links", () => {
  const document = dtcDocument(`<div id="product-grid">
    <a class="trust-score-badge" href="https://ratings.example/products/zinc">TrustScore</a>
    <a href="/products/zinc">Zinc</a>
    <a href="https://other.example/products/copper">Copper</a></div>`);
  expect(readPlatformCatalog(document, policy).products.map((entry) => entry.url)).toEqual([
    "https://shop.example/products/zinc",
    "https://other.example/products/copper",
  ]);
});

it("follows the observed accessible next-page link regardless of misleading arrow classes", () => {
  const document = dtcDocument(`${product}<nav class="pagination">
    <a class="pagination__item--next" aria-label="Previous page" href="?page=1">Previous</a>
    <a aria-label="Page 27" href="?page=27">27</a>
    <a class="pagination__item--prev" aria-label="Next page" href="?page=3"></a>
    </nav><nav><a aria-label="Next page" href="/blog?page=2">Blog</a></nav>`);
  expect(readPlatformCatalog(document, policy).nextUrl).toBe(
    "https://shop.example/collections/all?page=3",
  );
});

it.each(['aria-disabled="true"', "disabled"])("ignores a disabled next link: %s", (state) => {
  const document = dtcDocument(`${product}<nav class="pagination">
    <a aria-label="Next page" ${state} href="?page=2">Next</a></nav>`);
  expect(readPlatformCatalog(document, policy).nextUrl).toBeNull();
});

it("refuses disagreeing semantic and rel next links", () => {
  const document = dtcDocument(`${product}<nav class="pagination">
    <a rel="next" href="?page=2">Next</a>
    <a aria-label="Next page" href="?page=3">Next</a></nav>`);
  expect(() => readPlatformCatalog(document, policy)).toThrowError(
    expect.objectContaining({ code: "DTC.LISTING_UNVERIFIED" }),
  );
});
