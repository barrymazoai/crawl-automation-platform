import { platformPageErrors } from "./errors.js";
import { identifier, string } from "./json.js";
import { embeddedShopifyCatalogProducts } from "./shopify-data.js";
import type { PlatformCatalog } from "./types.js";
import { pageUrl } from "./urls.js";

export interface CatalogPolicy {
  url: string;
  catalogSelector: string;
  productLinkSelector: string;
  nextSelector: string;
  emptySelector: string;
}

function nextCatalogUrl(document: Document, policy: CatalogPolicy): string | null {
  const next = [...document.querySelectorAll(policy.nextSelector)]
    .filter(
      (node) => node.getAttribute("aria-disabled") !== "true" && !node.hasAttribute("disabled"),
    )
    .map((node) => node.getAttribute("href"))
    .filter((href) => href !== null)
    .map((href) => pageUrl(href, policy.url));
  if (new Set(next).size > 1) {
    throw platformPageErrors.create("DTC.LISTING_UNVERIFIED");
  }
  return next[0] ?? null;
}

/** Catalog-scoped links, plus embedded product IDs when present; no related-product or navigation links. */
export function readPlatformCatalog(document: Document, policy: CatalogPolicy): PlatformCatalog {
  const root = document.querySelector(policy.catalogSelector);
  const data = embeddedShopifyCatalogProducts(document);
  const products = new Map<string, PlatformCatalog["products"][number]>();
  for (const link of root?.querySelectorAll(policy.productLinkSelector) ?? []) {
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }
    const url = pageUrl(href, policy.url);
    const handle = new URL(url).pathname.split("/products/")[1]?.replace(/\/$/, "");
    const record = data.find((product) => product.handle === handle) ?? {};
    products.set(url, {
      url,
      productId: identifier(record.id),
      title: string(record.title) ?? string(link.textContent),
      brandRaw: string(record.vendor),
    });
  }
  const empty = Boolean(document.querySelector(policy.emptySelector));
  if (!products.size && !empty) {
    throw platformPageErrors.create("DTC.LISTING_UNVERIFIED");
  }
  return { products: [...products.values()], nextUrl: nextCatalogUrl(document, policy), empty };
}
