import {
  embeddedShopifyCatalogProducts,
  jsonLdProducts,
  schemaBrand,
  schemaUrl,
  object,
  string,
} from "@crawl-automation/channels-core";
import { dtcDocument } from "../product.js";
import type { AnalysisPage } from "./pages.js";

export interface BrandProduct {
  id: string;
  name: string | null;
  url: string | null;
}
export interface BrandTaxon {
  name: string;
  url: string;
}
export function renderedJson(page: AnalysisPage): unknown {
  const document = dtcDocument(page.html);
  const text =
    document.querySelector("pre")?.textContent ?? document.body?.textContent ?? page.html;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
export function shopifyProducts(page: AnalysisPage): BrandProduct[] | null {
  const products = object(renderedJson(page))?.products;
  if (!Array.isArray(products)) {
    return null;
  }
  return products.map((raw) => {
    const item = object(raw) ?? {};
    return {
      id: String(item.id ?? ""),
      name: string(item.vendor),
      url:
        typeof item.handle === "string" ? new URL(`/products/${item.handle}`, page.url).href : null,
    };
  });
}
export function wooProducts(page: AnalysisPage): BrandProduct[] | null {
  const value = renderedJson(page);
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((raw) => {
    const item = object(raw) ?? {};
    return {
      id: String(item.id ?? ""),
      name: schemaBrand(item.brands ?? item.brand),
      url: string(item.permalink),
    };
  });
}
export function wooTaxonomy(page: AnalysisPage): BrandTaxon[] {
  const value = renderedJson(page);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((raw) => {
    const item = object(raw) ?? {};
    const name = string(item.name);
    const url = string(item.permalink);
    return name && url ? [{ name, url }] : [];
  });
}
export function embeddedProducts(page: AnalysisPage): BrandProduct[] {
  const document = dtcDocument(page.html);
  const shopify = embeddedShopifyCatalogProducts(document).map((item) => ({
    id: String(item.id),
    name: string(item.vendor),
    url: new URL(`/products/${String(item.handle)}`, page.url).href,
  }));
  return shopify.length
    ? shopify
    : jsonLdProducts(document).map((item) => ({
        id: schemaUrl(item, page.url) ?? String(item.productID ?? item.sku ?? ""),
        name: schemaBrand(item.brand),
        url: schemaUrl(item, page.url),
      }));
}
export function platformHint(page: AnalysisPage): "shopify" | "woocommerce" | "jsonld" {
  const document = dtcDocument(page.html);
  if (
    embeddedShopifyCatalogProducts(document).length ||
    /cdn\.shopify\.com|Shopify\.shop/.test(page.html)
  ) {
    return "shopify";
  }
  return /woocommerce|wp-content\/plugins\/woocommerce/.test(page.html) ? "woocommerce" : "jsonld";
}

/** Product detail's own schema/brand taxonomy; no seller or navigation labels. */
export function ownProductBrand(page: AnalysisPage, url: string): string | null {
  const own = embeddedProducts(page).filter(
    (product) => product.url && sameProductUrl(product.url, url),
  );
  if (own.length === 1 && own[0]?.name) {
    return own[0].name;
  }
  const document = dtcDocument(page.html);
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
  if (!canonical || !sameProductUrl(new URL(canonical, page.url).href, url)) {
    return null;
  }
  const links = [
    ...document.querySelectorAll(
      '.product .product_meta a[href*="/product-brand/"], .product .product_meta a[rel="tag"][href*="/brand/"]',
    ),
  ];
  const names = [...new Set(links.map((link) => link.textContent.trim()).filter(Boolean))];
  return names.length === 1 ? (names[0] ?? null) : null;
}

function sameProductUrl(left: string, right: string): boolean {
  const first = new URL(left);
  const second = new URL(right);
  return (
    first.origin === second.origin &&
    first.pathname.replace(/\/$/, "") === second.pathname.replace(/\/$/, "")
  );
}
