import { readPlatformCatalog, type StorePlatform } from "@crawl-automation/channels-core";
import { errorCodeOf } from "@crawl-automation/platform";
import { dtcDocument } from "../product.js";
import { dtcSitePolicy } from "../site-policy.js";
import { embeddedProducts, ownProductBrand, type BrandProduct, type BrandTaxon } from "./data.js";
import { catalogLinks, safeLink } from "./links.js";
import type { AnalysisPage } from "./pages.js";
import type { AnalysisRead, Inventory } from "./model.js";

/** Static/embedded catalogs: follow only their own next links and validate every visible product. */
export async function structuredInventory(
  input: { home: AnalysisPage; platform: StorePlatform },
  read: AnalysisRead,
): Promise<Inventory> {
  const { home, platform } = input;
  const whole = catalogLinks(home)[0] ?? home.url;
  const data: Inventory = { platform, products: [], exact: false, catalogs: [], whole };
  const seen = new Set<string>();
  let url: string | null = whole;
  while (url && seen.size < read.limits.maxPages) {
    if (seen.has(url) || new URL(url).origin !== new URL(home.url).origin) {
      return data;
    }
    seen.add(url);
    const page = await read.pages.read(url, read.signal);
    const listing = catalog(page, platform);
    if (!listing) {
      data.products.push(...embeddedProducts(page));
      return data;
    }
    const products = await pageProducts(
      { page, urls: listing.products.map((product) => product.url) },
      read,
    );
    if (products.some((product) => data.products.some((previous) => previous.id === product.id))) {
      return data;
    }
    data.products.push(...products);
    data.catalogs.push(...brandCatalogs(page, products));
    if (incompletePage({ products, page, data }, read)) {
      return data;
    }
    url = listing.nextUrl;
  }
  data.exact = finishedCatalog({ next: url, products: data.products, whole, home: home.url });
  return data;
}
function catalog(page: AnalysisPage, platform: StorePlatform) {
  const policy = dtcSitePolicy({
    siteKey: new URL(page.url).hostname,
    platform,
    catalogUrl: page.url,
  });
  try {
    return readPlatformCatalog(dtcDocument(page.html), { ...policy.catalog, url: page.url });
  } catch (error) {
    if (errorCodeOf(error) === "DTC.LISTING_UNVERIFIED") {
      return null;
    }
    throw error;
  }
}
async function pageProducts(
  input: { page: AnalysisPage; urls: string[] },
  read: AnalysisRead,
): Promise<BrandProduct[]> {
  const products: BrandProduct[] = [];
  for (const url of input.urls) {
    if (new URL(url).origin !== new URL(input.page.url).origin) {
      products.push({ id: url, name: null, url });
      continue;
    }
    const name =
      ownProductBrand(input.page, url) ??
      ownProductBrand(await read.pages.read(url, read.signal), url);
    products.push({ id: url, name, url });
  }
  return products;
}
function hasMoreControl(page: AnalysisPage): boolean {
  return [
    ...dtcDocument(page.html).querySelectorAll("button, a[role='button'], [data-infinite-scroll]"),
  ].some(
    (node) =>
      /load more|show more|view more/i.test(node.textContent) ||
      node.hasAttribute("data-infinite-scroll"),
  );
}
function brandCatalogs(page: AnalysisPage, products: BrandProduct[]): BrandTaxon[] {
  const names = new Set(products.map((product) => product.name));
  return [...dtcDocument(page.html).querySelectorAll("a[href]")].flatMap((link) => {
    const name = link.textContent.trim();
    const url = safeLink(link.getAttribute("href") ?? "", page.url);
    return names.has(name) && url && new URL(url).origin === new URL(page.url).origin
      ? [{ name, url }]
      : [];
  });
}

function incompletePage(
  input: { products: BrandProduct[]; page: AnalysisPage; data: Inventory },
  read: AnalysisRead,
): boolean {
  return (
    input.products.some((product) => !product.name) ||
    hasMoreControl(input.page) ||
    new Set(input.data.products.map((product) => product.name)).size > read.limits.maxBrands
  );
}
function finishedCatalog(input: {
  next: string | null;
  products: BrandProduct[];
  whole: string;
  home: string;
}): boolean {
  return !input.next && input.products.length > 0 && input.whole !== input.home;
}
