import {
  canonicalUrl,
  channelErrors,
  platformPageErrors,
  readJsonLdProduct,
  readShopifyProduct,
  readWooCommerceProduct,
  jsonLdBreadcrumbs,
  type FetchedPage,
  type PlatformProduct,
} from "@crawl-automation/channels-core";
import { parseHTML } from "linkedom";
import { dtcProductAddress, siteForUrl } from "./address.js";
import { DTC_PAGE_LIMITS, type DtcSitePolicy } from "./site-policy.js";

export function dtcDocument(html: string): Document {
  if (Buffer.byteLength(html) > DTC_PAGE_LIMITS.maxBytes) {
    throw platformPageErrors.create("DTC.PAGE_LIMIT");
  }
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent ?? "";
  if (/just a moment|access denied|verify you are human/i.test(title)) {
    throw channelErrors.create("CAPTURE.ACCESS_CHALLENGE");
  }
  return document;
}

export function readDtcProduct(
  page: FetchedPage,
  sites: readonly DtcSitePolicy[],
): PlatformProduct {
  const site = siteForUrl(page.url, sites);
  if (site.platform === "unverified") {
    throw platformPageErrors.create("DTC.PLATFORM_UNVERIFIED", { details: { site: site.siteKey } });
  }
  const readers = {
    shopify: readShopifyProduct,
    woocommerce: readWooCommerceProduct,
    jsonld: readJsonLdProduct,
  };
  const context = {
    url: page.url,
    siteKey: site.siteKey,
    imageOrigins: site.imageOrigins,
    ...(site.productSelector ? { productSelector: site.productSelector } : {}),
  };
  const document = dtcDocument(page.html);
  const product = (site.readProduct ?? readers[site.platform])(document, context);
  siteForUrl(product.url, [site]);
  // A task for `?variant=<id>` needs the page to confirm a variant; a page that renders another variant instead is
  // an identity conflict, judged by the shared capture from the page identity (step 2, owner 2026-10-21).
  if (dtcProductAddress(page.url, sites).variantId && product.selectedVariantId === null) {
    throw platformPageErrors.create("DTC.IDENTITY_UNVERIFIED");
  }
  const categories = storeCategories(document, product);
  return categories.length ? { ...product, categories } : product;
}

/** The capture result carries at most this many store categories (pipeline-model nonSupplement). */
const MAX_CATEGORIES = 20;

/**
 * The store's filing of the product: its JSON-LD breadcrumb, then the platform's own type and tags, at most 20 in
 * all. Nature's Truth tags an oil with a dozen misspellings (2026-10-21); a longer list failed the capture result's
 * schema and ended the product as PIPELINE.PRODUCT_UNRESOLVED instead of "not a supplement".
 */
function storeCategories(document: Document, product: PlatformProduct): string[] {
  const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].map(
    (script) => script.textContent ?? "",
  );
  return [...new Set([...jsonLdBreadcrumbs(scripts), ...(product.categories ?? [])])].slice(
    0,
    MAX_CATEGORIES,
  );
}

/** Read a canonical redirect before title/facts parsing; core owns the identity_conflict comparison. */
export function dtcPageIdentity(page: FetchedPage, sites: readonly DtcSitePolicy[]) {
  const document = dtcDocument(page.html);
  const ownUrl = canonicalUrl(document, page.url);
  const requested = dtcProductAddress(page.url, sites);
  if (ownUrl) {
    const observed = dtcProductAddress(ownUrl, sites);
    if (observed.listingId !== requested.listingId) {
      return { listingId: observed.listingId, variantId: observed.variantId };
    }
  }
  const product = readDtcProduct(page, sites);
  return {
    listingId: dtcProductAddress(product.url, sites).listingId,
    variantId: product.selectedVariantId,
  };
}
