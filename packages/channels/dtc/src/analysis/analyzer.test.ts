import { expect, it, vi } from "vitest";
import { DtcSiteAnalyzer } from "./analyzer.js";
import { SiteAnalysisLimitsSchema } from "@crawl-automation/v3-contracts";
import type { AnalysisPages } from "./pages.js";

const limits = SiteAnalysisLimitsSchema.parse({});
const signal = () => AbortSignal.timeout(5000);
const document = (html: string) => `<html><body>${html}</body></html>`;
const json = (value: unknown) => document(`<pre>${JSON.stringify(value)}</pre>`);
const vendor = (name: string) => `/collections/vendors?q=${encodeURIComponent(name)}`;
function shopifyCatalog(name: string) {
  return document(`<main><div id="product-grid"><a href="/products/${name}">${name}</a></div></main>
    <script type="application/json">${JSON.stringify({ products: [{ id: name, handle: name, vendor: name }] })}</script>`);
}
function wooCatalog(name: string, origin: string) {
  return document(`<main><ul class="products"><li><a class="woocommerce-LoopProduct-link" href="/product/${name}">${name}</a></li></ul></main>
    <script type="application/ld+json">${JSON.stringify({ "@type": "Product", url: `${origin}/product/${name}`, brand: { name } })}</script>`);
}
function shopify(origin: string, names: string[]) {
  const map = new Map<string, string>([[`${origin}/`, document("<main>Shop</main>")]]);
  map.set(
    `${origin}/products.json?limit=250&page=1`,
    json({ products: names.map((name, index) => ({ id: index + 1, handle: name, vendor: name })) }),
  );
  names.forEach((name) =>
    map.set(
      `${origin}${names.length === 1 ? "/collections/all" : vendor(name)}`,
      shopifyCatalog(name),
    ),
  );
  return map;
}
function woo(origin: string, names: string[]) {
  const map = new Map<string, string>([
    [`${origin}/`, document('<main class="woocommerce">Shop</main>')],
  ]);
  map.set(
    `${origin}/wp-json/wc/store/v1/products?per_page=100&page=1`,
    json(
      names.map((name, index) => ({
        id: index + 1,
        permalink: `${origin}/product/${name}`,
        brands: [{ name }],
      })),
    ),
  );
  map.set(
    `${origin}/wp-json/wc/store/v1/products/brands?per_page=100`,
    json(names.map((name) => ({ name, permalink: `${origin}/product-brand/${name}/` }))),
  );
  names.forEach((name) =>
    map.set(
      `${origin}${names.length === 1 ? "/shop/" : `/product-brand/${name}/`}`,
      wooCatalog(name, origin),
    ),
  );
  return map;
}
function setup(map: Map<string, string>, settings = limits) {
  const read = vi.fn<AnalysisPages["read"]>(async (raw) => {
    const url = new URL(raw).href;
    return {
      url,
      html: map.get(url) ?? document("<main>Not found</main>"),
      archiveKey: `evidence/${encodeURIComponent(url)}`,
    };
  });
  return {
    analyze: (url: string) => new DtcSiteAnalyzer({ read }, settings).analyze(url, signal()),
    read,
  };
}

it("Shopify single vendor uses the whole catalog and an exact count", async () => {
  const { analyze } = setup(shopify("https://store.example", ["Alpha"]));
  const result = await analyze("https://store.example/");
  expect(result.state).toBe("completed");
  expect(result.brands).toMatchObject([
    {
      name: "Alpha",
      platform: "shopify",
      catalogUrl: "https://store.example/collections/all",
      wholeCatalog: true,
      productCount: 1,
      countExact: true,
      status: "verified",
    },
  ]);
  expect(result.archiveKeys).toHaveLength(3);
});
it("Shopify two vendors produce separate verified vendor catalogs", async () => {
  const { analyze } = setup(shopify("https://store.example", ["Alpha", "Beta"]));
  const result = await analyze("https://store.example/");
  expect(result.state).toBe("completed");
  expect(result.brands.map((brand) => brand.catalogUrl)).toEqual([
    "https://store.example/collections/vendors?q=Alpha",
    "https://store.example/collections/vendors?q=Beta",
  ]);
  expect(result.brands.every((brand) => brand.productCount === 1 && !brand.wholeCatalog)).toBe(
    true,
  );
});
it("WooCommerce reads product brands and observed taxonomy archive URLs", async () => {
  const { analyze } = setup(woo("https://woo.example", ["Alpha", "Beta"]));
  const result = await analyze("https://woo.example/");
  expect(result.state).toBe("completed");
  expect(result.brands).toMatchObject([
    {
      name: "Alpha",
      platform: "woocommerce",
      catalogUrl: "https://woo.example/product-brand/Alpha/",
    },
    { name: "Beta", productCount: 1 },
  ]);
});
it("WooCommerce without Store API brand fields reads the product's own taxonomy", async () => {
  const map = woo("https://woo.example", ["Alpha"]);
  map.set(
    "https://woo.example/wp-json/wc/store/v1/products?per_page=100&page=1",
    json([{ id: 1, permalink: "https://woo.example/product/Alpha" }]),
  );
  map.set(
    "https://woo.example/product/Alpha",
    document(
      '<link rel="canonical" href="/product/Alpha"><div class="product"><div class="product_meta"><a href="/product-brand/alpha/">Alpha</a></div></div>',
    ),
  );
  expect((await setup(map).analyze("https://woo.example/")).state).toBe("completed");
});
it("parent brand page follows each child domain once, excludes retailers and stops at depth 1", async () => {
  const map = new Map([
    ...shopify("https://alpha.example", ["Alpha"]),
    ...woo("https://beta.example", ["Beta"]),
  ]);
  map.set("https://parent.example/", document('<nav><a href="/our-brands">Our Brands</a></nav>'));
  map.set(
    "https://parent.example/our-brands",
    document(
      '<main><a href="https://alpha.example/">Alpha</a><a href="https://alpha.example/about">Alpha again</a><a href="https://beta.example/">Beta</a><a href="https://www.amazon.com/">Amazon</a><a href="https://target.com/">Target</a><a href="https://instagram.com/alpha">Social</a></main>',
    ),
  );
  map.set(
    "https://alpha.example/",
    document(
      '<section><h2>Our Brands</h2><a href="https://grandchild.example/">Grandchild</a></section>',
    ),
  );
  const { analyze, read } = setup(map);
  const result = await analyze("https://parent.example/");
  expect(result.state).toBe("completed");
  expect(result.brands.map((brand) => brand.domain)).toEqual(["alpha.example", "beta.example"]);
  expect(result.brands[0]?.discoveredFrom).toMatchObject({
    page: "https://parent.example/our-brands",
    link: "https://alpha.example/about",
  });
  expect(read.mock.calls.some(([url]) => /amazon|target|instagram|grandchild/.test(url))).toBe(
    false,
  );
  expect(
    read.mock.calls.filter(([url]) => new URL(url).href === "https://alpha.example/"),
  ).toHaveLength(1);
});
it("cap exceeded returns needs-review before catalog verification", async () => {
  const { analyze, read } = setup(shopify("https://store.example", ["Alpha", "Beta"]), {
    ...limits,
    maxBrands: 1,
  });
  const result = await analyze("https://store.example/");
  expect(result.state).toBe("needs-review");
  expect(result.reasons).toContain("Brand cap exceeded; nothing may be applied");
  expect(read.mock.calls.some(([url]) => url.includes("/collections/"))).toBe(false);
});
it("mixed-brand catalog and anonymous product data need review", async () => {
  const map = shopify("https://store.example", ["Alpha", "Beta"]);
  map.set("https://store.example/collections/vendors?q=Alpha", shopifyCatalog("Beta"));
  const result = await setup(map).analyze("https://store.example/");
  expect(result.state).toBe("needs-review");
  expect(result.brands[0]?.reason).toBe("Catalog product brand missing or conflicting");
});
it("paginates Shopify products instead of treating the first 250 as complete", async () => {
  const map = shopify("https://store.example", ["Alpha", "Beta"]);
  map.set(
    "https://store.example/products.json?limit=250&page=1",
    json({
      products: Array.from({ length: 250 }, (_, index) => ({
        id: index + 1,
        vendor: "Alpha",
        handle: `alpha-${index}`,
      })),
    }),
  );
  map.set(
    "https://store.example/products.json?limit=250&page=2",
    json({ products: [{ id: 251, vendor: "Beta", handle: "Beta" }] }),
  );
  const result = await setup(map).analyze("https://store.example/");
  expect(result.state).toBe("completed");
  expect(result.brands.map((brand) => brand.productCount)).toEqual([250, 1]);
});
it("JSON-LD static whole catalog uses product brand fields and observed pagination", async () => {
  const map = new Map<string, string>();
  map.set("https://schema.example/", document('<nav><a href="/shop">All products</a></nav>'));
  map.set("https://schema.example/shop", wooCatalog("Alpha", "https://schema.example"));
  const result = await setup(map).analyze("https://schema.example/");
  expect(result.state).toBe("completed");
  expect(result.brands).toMatchObject([
    {
      name: "Alpha",
      platform: "jsonld",
      catalogUrl: "https://schema.example/shop",
      productCount: 1,
      wholeCatalog: true,
    },
  ]);
});
