import type { AnalysisRead, Inventory } from "./model.js";
import { structuredInventory } from "./structured-inventory.js";
import {
  shopifyProducts,
  wooProducts,
  wooTaxonomy,
  platformHint,
  ownProductBrand,
  type BrandProduct,
} from "./data.js";
import { catalogLinks } from "./links.js";
import type { AnalysisPage } from "./pages.js";

async function paged(read: AnalysisRead, start: string, parser: typeof shopifyProducts) {
  const products: BrandProduct[] = [];
  const seen = new Set<string>();
  for (let position = 1; position <= read.limits.maxPages; position += 1) {
    const url = new URL(start);
    url.searchParams.set("page", String(position));
    const page = parser(await read.pages.read(url.href, read.signal));
    if (!page) {
      return { products, exact: false };
    }
    if (!page.length) {
      return { products, exact: products.length > 0 };
    }
    if (!validPage(page, seen)) {
      return { products, exact: false };
    }
    page.forEach((product) => seen.add(product.id));
    await hydrateBrands({ page, origin: url.origin }, read);
    products.push(...page);
    if (page.some((product) => !product.name)) {
      return { products, exact: false };
    }
    const size = Number(url.searchParams.get("limit") ?? url.searchParams.get("per_page"));
    if (page.length < size) {
      return { products, exact: true };
    }
    if (new Set(products.map((product) => product.name)).size > read.limits.maxBrands) {
      return { products, exact: false };
    }
  }
  return { products, exact: false };
}

export async function inventory(home: AnalysisPage, read: AnalysisRead): Promise<Inventory> {
  const origin = new URL(home.url).origin;
  const hint = platformHint(home);
  const shopify =
    hint !== "woocommerce"
      ? await paged(read, `${origin}/products.json?limit=250`, shopifyProducts)
      : null;
  if (shopify?.products.length) {
    return { ...shopify, platform: "shopify", catalogs: [], whole: `${origin}/collections/all` };
  }
  const woo = await paged(read, `${origin}/wp-json/wc/store/v1/products?per_page=100`, wooProducts);
  if (woo.products.length) {
    const taxonomy = await read.pages.read(
      `${origin}/wp-json/wc/store/v1/products/brands?per_page=100`,
      read.signal,
    );
    return {
      ...woo,
      platform: "woocommerce",
      catalogs: wooTaxonomy(taxonomy),
      whole: catalogLinks(home)[0] ?? `${origin}/shop/`,
    };
  }
  return structuredInventory({ home, platform: hint }, read);
}

async function hydrateBrands(input: { page: BrandProduct[]; origin: string }, read: AnalysisRead) {
  for (const product of input.page) {
    if (!product.name && product.url && new URL(product.url).origin === input.origin) {
      product.name = ownProductBrand(await read.pages.read(product.url, read.signal), product.url);
    }
  }
}

function validPage(page: BrandProduct[], seen: Set<string>): boolean {
  return (
    new Set(page.map((product) => product.id)).size === page.length &&
    new Set(page.map((product) => product.url)).size === page.length &&
    !page.some((product) => !product.id || !product.url || seen.has(product.id))
  );
}
