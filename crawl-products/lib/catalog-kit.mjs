import { normalizeProductUrl } from "./engine.mjs";

/**
 * Common catalog method (owner 2026-10-06): the model fills in observed facts, this tested code does the rest.
 *
 *   import { defineCatalogMethod } from "<skillRoot>/lib/catalog-kit.mjs";
 *   export const { prepare, projectPage } = defineCatalogMethod({
 *     ready: "ul.products li",                  // the product grid is rendered
 *     productLinks: "ul.products li a[href*='/product/']", // product links inside that grid only
 *     title: ".woocommerce-loop-product__title", // optional, inside the card; default: the link text
 *     card: "ul.products li",                   // optional, the element holding one product
 *     pagination: { mode: "link" },              // "none" | "link" | "click" (+ next) | "scroll"
 *     brand: null,                               // optional per-card brand rule for multi-brand sites
 *     identity: "img[alt*='BioMatrix' i]",      // optional, checked once on the first catalog page
 *     count: { selector: ".count", pattern: "(\\d+) items" }, // optional total shown by the site
 *   });
 *
 * prepare runs in the live browser; projectPage reads the saved page HTML in Node. Links are always resolved
 * against the page URL it is given (there is no `location` or `document.baseURI` in Node).
 */
export function defineCatalogMethod(config) {
  const settings = validated(config);
  return {
    prepare: (input) => prepare(settings, input),
    projectPage: (input) => projectPage(settings, input),
  };
}

function validated(config) {
  const modes = ["none", "link", "click", "scroll"];
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  if (!config || !text(config.ready) || !text(config.productLinks)
    || !modes.includes(config.pagination?.mode)
    || (config.pagination.mode === "click" && !text(config.pagination.next))) {
    throw new Error("catalog_kit_config_invalid");
  }
  return config;
}

async function prepare(config, { page, tab, sourceUrl, navigate }) {
  const catalogUrl = config.catalogUrl ?? sourceUrl;
  if (typeof navigate === "function") await navigate(catalogUrl);
  else await tab.goto(catalogUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForFunction((selector) => document.querySelectorAll(selector).length > 0,
    config.ready, { timeout: 20_000 });
  const observed = await page.evaluate(({ productLinks, identity, count }) => {
    const total = count ? document.querySelector(count.selector)?.textContent?.trim() ?? null : null;
    return {
      links: document.querySelectorAll(productLinks).length,
      identity: identity ? Boolean(document.querySelector(identity)) : true,
      total,
    };
  }, { productLinks: config.productLinks, identity: config.identity ?? null, count: config.count ?? null });
  if (!observed.links) throw new Error("catalog_kit_no_product_links");
  if (!observed.identity) throw new Error("catalog_kit_identity_not_found");
  const expected = totalShown(config.count, observed.total);
  const { mode, next } = config.pagination;
  const paginationActions = mode === "click" ? [{ action: "click", selector: next }] : [];
  const listing = {
    productLinkSelectors: [config.productLinks],
    paginationActions,
    scrollListings: mode === "scroll",
  };
  return {
    seedUrls: [catalogUrl],
    listingOptions: {
      ...listing,
      listingProfile: listing,
      listingCoverage: [{ url: catalogUrl, paginationMode: mode, verifiedVisually: true }],
      completionProof: "enumeration",
      extraRoundsAfterConverge: 1,
      maxRounds: 4,
      maxPagesPerSeed: config.maxPages ?? (mode === "none" ? 1 : 100),
      maxItems: 10_000,
    },
    oracle: expected === null
      ? { expected: null, comparable: false, basis: "no total shown by the site" }
      : { expected, comparable: true, basis: `site total: ${observed.total}` },
    observation: observed,
  };
}

/** A shown total is compared only when the configured pattern reads it; otherwise there is no oracle. */
function totalShown(count, shown) {
  if (!count || !shown) return null;
  const match = new RegExp(count.pattern ?? "(\\d+)", "i").exec(shown.replace(/,/g, ""));
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function projectPage(config, { document, url }) {
  const seen = new Set();
  const entries = [];
  for (const anchor of document.querySelectorAll(config.productLinks)) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    let productUrl;
    try { productUrl = normalizeProductUrl(new URL(href, url).href); } catch { continue; }
    if (seen.has(productUrl)) continue;
    seen.add(productUrl);
    const card = config.card ? anchor.closest(config.card) : null;
    entries.push({ url: productUrl, title: titleOf(config, { anchor, card, productUrl }), brand: brandOf(config, card) });
  }
  return entries;
}

function titleOf(config, { anchor, card, productUrl }) {
  const clean = (value) => (value ?? "").replace(/\s+/g, " ").trim();
  const fromCard = config.title && card ? clean(card.querySelector(config.title)?.textContent) : "";
  return fromCard || clean(anchor.textContent) || clean(anchor.getAttribute("aria-label"))
    || clean(anchor.querySelector("img")?.getAttribute("alt")) || slugTitle(productUrl);
}

function brandOf(config, card) {
  if (!config.brand || !card) return null;
  return card.querySelector(config.brand)?.textContent?.replace(/\s+/g, " ").trim() || null;
}

/** The URL's last path segment as readable text, used only when the page shows no product name. */
export function slugTitle(productUrl) {
  const segment = new URL(productUrl).pathname.split("/").filter(Boolean).at(-1) ?? productUrl;
  return decodeURIComponent(segment).replace(/[-_]+/g, " ").trim() || productUrl;
}
