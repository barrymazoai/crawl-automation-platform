import {
  brandScanErrors,
  type BrandScanReader,
  type ListedProduct,
  type ListingPage,
} from "@crawl-automation/channels-core";

const ORIGIN = "https://www.swansonvitamins.com";
/** Shopify collection pages hold at most 250 products; a shorter page ends the list. */
const PAGE_SIZE = 250;
const MAX_PAGES = 50;
const SLUG = /^\/collections\/brand-([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/products\.json)?\/?$/;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ListedJsonProduct {
  id: string;
  handle: string;
  title: string | null;
}

/** A Shopify collection product: its numeric ID, its handle, and a variant list. */
function jsonProduct(raw: unknown): ListedJsonProduct {
  const item = (raw ?? {}) as {
    id?: unknown;
    handle?: unknown;
    title?: unknown;
    variants?: unknown;
  };
  const id = String(item.id ?? "");
  const handle = typeof item.handle === "string" ? item.handle : "";
  if (!/^\d{6,20}$/.test(id) || !HANDLE.test(handle) || !Array.isArray(item.variants)) {
    throw brandScanErrors.create("BRAND_SCAN.TILE_IDENTITY");
  }
  const title = typeof item.title === "string" ? item.title.slice(0, 300) : null;
  return { id, handle, title };
}

function slugOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch (error) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { cause: error });
  }
  const slug = url.pathname.match(SLUG)?.[1];
  const ownSite = [ORIGIN, "https://swansonvitamins.com"].includes(url.origin);
  if (!ownSite || url.username || url.password || !slug) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { url: raw } });
  }
  return slug;
}

function pageUrl(sourceUrl: string, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) {
    throw brandScanErrors.create("BRAND_SCAN.URL", { details: { page } });
  }
  const url = new URL(`${ORIGIN}/collections/brand-${slugOf(sourceUrl)}/products.json`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  return url.href;
}

function parseJson(body: string): unknown[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    const challenge = /cf-chl|Just a moment|Attention Required|captcha/i.test(body);
    const code = challenge ? "BRAND_SCAN.ACCESS_CHALLENGE" : "BRAND_SCAN.NOT_JSON";
    throw brandScanErrors.create(code, { cause: error });
  }
  const products = (json as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) {
    throw brandScanErrors.create("BRAND_SCAN.NOT_JSON");
  }
  return products;
}

/** One brand collection page from Shopify's own collection JSON. Each size is its own product (own handle). */
function parsePage(page: { body: string; url: string; page: number }): ListingPage {
  const products = parseJson(page.body).map(jsonProduct);
  if (products.length > PAGE_SIZE) {
    throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
  }
  const listed = new Map<string, ListedProduct>();
  for (const product of products) {
    const url = `${ORIGIN}/p/${product.handle}`;
    const title = product.title;
    listed.set(product.handle, {
      url,
      listingId: product.handle,
      variantId: null,
      title,
      kind: "product",
    });
  }
  const nextPage = products.length === PAGE_SIZE ? page.page + 1 : null;
  return { products: [...listed.values()], cards: products.length, nextPage, statedTotal: null };
}

/**
 * Swanson brand scans: `/collections/brand-<slug>/products.json?limit=250&page=N` through ScraperAPI (checked
 * 2026-09-28: 1 credit, no challenge). A page shorter than 250 ends the list, so a finished scan is a full one.
 */
export const swansonBrandScan: BrandScanReader = {
  sourceUrl: (url) => `${ORIGIN}/collections/brand-${slugOf(url)}`,
  pageUrl,
  answer: "json",
  maxPages: MAX_PAGES,
  maxBytes: 16 * 1024 * 1024,
  parsePage,
  complete: (pages) => pages.length > 0 && pages.at(-1)?.nextPage === null,
};
