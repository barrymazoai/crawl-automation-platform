const STOCK = new Map([
  ["InStock", true], ["LimitedAvailability", true], ["OnlineOnly", true],
  ["OutOfStock", false], ["SoldOut", false], ["Discontinued", false],
]);
const KNOWN = new Set([...STOCK.keys(), "PreOrder", "PreSale", "BackOrder", "InStoreOnly"]);

/** Read exact product/variant offers from retained HTML, never whole-page stock wording. */
export function nativeAvailability(html, productUrl, variants) {
  const offers = [];
  for (const match of String(html || "").matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collect(JSON.parse(match[1]), null, offers); } catch { /* Malformed metadata proves nothing. */ }
  }
  const own = offers.flatMap(({ offer, product }) => {
    const target = address(offer.url || product?.url, productUrl);
    const requested = address(productUrl, productUrl);
    if (!target || target.origin !== requested.origin || target.pathname !== requested.pathname) return [];
    const parent = address(product?.url, productUrl);
    if (parent && (parent.origin !== requested.origin || parent.pathname !== requested.pathname)) return [];
    const value = String(offer.availability || "").replace(/^https?:\/\/schema\.org\//, "");
    return KNOWN.has(value) ? [{ value, variantId: target.searchParams.get("variant") || target.searchParams.get("variation_id") }] : [];
  });
  const conflicts = new Set();
  const updated = variants.map(variant => {
    const states = own.filter(offer => offer.variantId === variant.variantId || (!offer.variantId && variants.length === 1));
    const availability = unique(states.map(offer => offer.value));
    // A real platform boolean is independent evidence; conflicts must remain visible.
    if ((states.length && !availability) || (availability && typeof variant.available === "boolean" && STOCK.has(availability) && variant.available !== STOCK.get(availability))) {
      conflicts.add(variant.variantId);
      return variant;
    }
    if (!availability) return variant;
    return { ...variant, availability, ...(STOCK.has(availability) ? { available: STOCK.get(availability) } : {}) };
  });
  const selected = new URL(productUrl).searchParams.get("variant") || new URL(productUrl).searchParams.get("variation_id");
  const relevant = selected ? updated.filter(variant => variant.variantId === selected) : updated;
  const states = relevant.map(variant => variant.availability ||
    (typeof variant.available === "boolean" ? (variant.available ? "InStock" : "OutOfStock") : null));
  const conflict = relevant.some(variant => conflicts.has(variant.variantId));
  const availability = conflict ? null : states.length ? (states.every(Boolean) ? unique(states) : null)
    : unique(own.filter(offer => !selected || offer.variantId === selected).map(offer => offer.value));
  return { variants: updated, flags: [...conflicts].map(id => `availability_conflict:${id}`), fields: {
    availability: availability || "",
    availabilitySource: availability ? "website-product-variant" : "unverified",
  } };
}

function address(value, base) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/$/, "");
    return url;
  } catch { return null; }
}

function unique(values) {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

function collect(value, parentProduct, offers) {
  if (Array.isArray(value)) { for (const entry of value) collect(entry, parentProduct, offers); return; }
  if (!value || typeof value !== "object") return;
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  const product = types.some(type => type === "Product" || type === "ProductGroup")
    ? { ...parentProduct, ...value } : parentProduct;
  if (types.includes("Offer") && product) offers.push({ offer: value, product });
  // Do not walk recommendations/reviews or arbitrary objects that happen to contain stock strings.
  for (const key of ["@graph", "hasVariant", "offers"]) if (value[key]) collect(value[key], product, offers);
}
