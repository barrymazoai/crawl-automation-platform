/** Legacy V3 Shopify directory oracle. API-only products are never discovery. */
export function dtcCatalogCoverageTarget(url) {
  const root = new URL(url), match = /^\/collections\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/?$/.exec(root.pathname);
  if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash || !match) return undefined;
  return match[1] === "all"
    ? { version: "shopify-all-products/1", endpoint: root.origin + "/products.json" }
    : { version: "shopify-collection-products/1", endpoint: root.origin + "/collections/" + match[1] + "/products.json" };
}

/** Same bounded set/empty-page proof as the old V3 verifier, shared with the host. */
export function verifyDtcCatalogCoverage(proof, url, entries) {
  const root = new URL(url), target = dtcCatalogCoverageTarget(url);
  const fail = () => { throw new Error("DTC.CATALOG_END_UNVERIFIED"); };
  if (!target || proof.version !== target.version || proof.catalogUrl !== url || proof.dom?.url !== url) fail();
  if (!Array.isArray(proof.dom.links) || proof.dom.links.length > 1000
    || !Array.isArray(proof.responses) || proof.responses.length < 1 || proof.responses.length > 2) fail();
  const canonical = raw => {
    const u = new URL(raw);
    if (u.origin !== root.origin || u.username || u.password) return null;
    const match = /^(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/.exec(u.pathname);
    return match ? `${root.origin}/products/${match[1]}` : null;
  };
  const observed = [...new Set(proof.dom.links.map(canonical).filter(Boolean))].sort();
  const discovered = entries.map(entry => canonical(entry.url));
  if (discovered.some(url => url === null) || new Set(discovered).size !== discovered.length) fail();
  const products = [];
  let terminal = false;
  for (const [index, response] of proof.responses.entries()) {
    if (terminal || response.status !== 200 || response.url !== `${target.endpoint}?limit=100&page=${index + 1}`
      || !/json/i.test(response.contentType) || typeof response.body !== "string" || response.body.length > 524288) fail();
    const data = JSON.parse(response.body);
    if (!Array.isArray(data.products) || data.products.length > 100) fail();
    if (!data.products.length) { terminal = true; continue; }
    for (const product of data.products) {
      if (typeof product.handle !== "string" || !product.handle || /[/\\?#\s]/.test(product.handle)
        || !Number.isSafeInteger(product.id) || product.id <= 0) fail();
      products.push(`${root.origin}/products/${product.handle}`);
    }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!terminal || products.length > 100 || new Set(products).size !== products.length
    || !same(products.sort(), observed) || !same([...discovered].sort(), observed)) fail();
  return true;
}
