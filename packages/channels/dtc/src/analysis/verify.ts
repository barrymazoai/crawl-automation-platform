import { catalogUrl } from "../address.js";
import { readPlatformCatalog } from "@crawl-automation/channels-core";
import { SiteUrlSchema, type AnalyzedBrand } from "@crawl-automation/v3-contracts";
import { dtcDocument } from "../product.js";
import { dtcSitePolicy } from "../site-policy.js";
import { sameDtcBrand } from "../brand-source.js";
import { ownProductBrand } from "./data.js";
import type { AnalysisPage } from "./pages.js";
import type { AnalysisRead, Inventory } from "./model.js";

export function candidates(home: AnalysisPage, data: Inventory): AnalyzedBrand[] {
  const names = [
    ...new Map(
      data.products.flatMap((product) =>
        product.name ? [[product.name.trim().toLowerCase(), product.name.trim()] as const] : [],
      ),
    ).values(),
  ];
  const single = data.exact && names.length === 1;
  return names.map((name) => ({
    name,
    domain: new URL(home.url).hostname,
    platform: data.platform,
    catalogUrl: single ? data.whole : brandCatalog(home.url, name, data),
    productCount: data.products.filter(
      (product) => product.name && sameDtcBrand(product.name, name),
    ).length,
    countExact: data.exact,
    wholeCatalog: single,
    discoveredFrom: "platform-data",
    status: "needs-review",
    reason: null,
  }));
}
function brandCatalog(url: string, name: string, data: Inventory): string | null {
  if (data.platform === "shopify") {
    const catalog = new URL("/collections/vendors", url);
    catalog.searchParams.set("q", name);
    return catalog.href;
  }
  const catalogs = data.catalogs.filter((entry) => sameDtcBrand(entry.name, name));
  return new Set(catalogs.map((entry) => entry.url)).size === 1 ? (catalogs[0]?.url ?? null) : null;
}

export async function verifyCatalog(
  brand: AnalyzedBrand,
  read: AnalysisRead,
): Promise<AnalyzedBrand> {
  if (!ownCatalog(brand)) {
    return { ...brand, reason: "No unambiguous catalog on the verified domain" };
  }
  const page = await read.pages.read(brand.catalogUrl as string, read.signal);
  const site = dtcSitePolicy({
    siteKey: brand.domain,
    platform: brand.platform,
    catalogUrl: brand.catalogUrl,
  });
  catalogUrl(page.url, site, brand.catalogUrl);
  const listing = readPlatformCatalog(dtcDocument(page.html), { ...site.catalog, url: page.url });
  if (!listing.products.length || listing.products.length > 40) {
    return { ...brand, reason: "Catalog verification needs 1–40 visible products" };
  }
  for (const product of listing.products) {
    if (new URL(product.url).hostname !== brand.domain) {
      return { ...brand, reason: "Catalog contains external product links" };
    }
    let name = ownProductBrand(page, product.url);
    if (!name) {
      name = ownProductBrand(await read.pages.read(product.url, read.signal), product.url);
    }
    if (!name || !sameDtcBrand(name, brand.name)) {
      return { ...brand, reason: "Catalog product brand missing or conflicting" };
    }
  }
  return { ...brand, status: "verified", reason: null };
}

function ownCatalog(brand: AnalyzedBrand): boolean {
  return (
    !!brand.catalogUrl &&
    SiteUrlSchema.safeParse(brand.catalogUrl).success &&
    new URL(brand.catalogUrl).hostname === brand.domain
  );
}
