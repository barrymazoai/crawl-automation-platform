export const sectionUrl = "https://shop.example/products/magnesium";
export const sectionContext = {
  url: sectionUrl,
  siteKey: "shop.example",
  imageOrigins: ["https://shop.example", "https://cdn.shopify.com"],
};
export const sectionFacts =
  "<h2>Supplement Facts</h2><p>Serving Size: 2 capsules</p>" +
  "<p>Magnesium 100 mg</p><p>Other Ingredients: cellulose.</p>";

/** Synthetic theme structure only; never a saved storefront page. */
export function sectionPage(options: { root?: string; lower?: string; outside?: string } = {}) {
  const schema = {
    "@type": "Product",
    name: "Magnesium",
    productID: "123",
    url: sectionUrl,
    image: "/front.jpg",
    offers: { price: "12.50", priceCurrency: "USD" },
  };
  const shopify = {
    id: 123,
    handle: "magnesium",
    title: "Magnesium",
    images: ["/front.jpg"],
    variants: [{ id: 11, price: 1250, available: true }],
  };
  return `<html><head><link rel="canonical" href="${sectionUrl}"></head><body>
    <script type="application/ld+json">${JSON.stringify(schema)}</script>
    <script type="application/json">${JSON.stringify(shopify)}</script>
    <main id="MainContent"><product-info data-product-id="123">
    <h1>Magnesium</h1>
    ${options.root ?? ""}</product-info>${options.lower ?? ""}</main>${options.outside ?? ""}
    </body></html>`;
}
