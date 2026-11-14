import type { AmazonDocument } from "./dom.js";

// These Store selectors also appear in the retained legacy Amazon catalog reader. Global Amazon
// navigation, recommendations and arbitrary /dp links are deliberately outside these scopes.
export const STORE_SELECTORS = {
  navigation:
    'nav[class*="Navigation__navBar__"], [role="navigation"][aria-label$="Navigation Bar"]',
  tiles:
    'li[class*="ProductGridItem__itemOuter__"], [class*="ProductCard__"], [data-testid="product-tile"]',
  grid: '[class*="ProductGrid__grid__"], [data-testid="product-grid"]',
  /**
   * A Store's own header: a one-page Store has no navigation bar, only its header and breadcrumb (63 of 500 Stores,
   * 2026-11-14, e.g. GOJOY NATURALS). A product page carries neither.
   */
  header: '[data-testid="header-nav-area"], [class*="Breadcrumbs__breadcrumbs__"]',
  /** Product modules of a one-page Store without a product grid (48 of those 63 show their products only here). */
  modules:
    '[class*="ProductShowcase__"], [class*="ProductCarouselItem__"], [class*="EditorialTile__"]',
};

/** Self-contained so the same read-only projection runs in Ego and over retained HTML. */
export function inspectStoreDom(document: AmazonDocument, selectors: typeof STORE_SELECTORS) {
  const navigation = [...document.querySelectorAll(selectors.navigation)];
  const links = navigation.flatMap((nav) => [...nav.querySelectorAll("a[href]")]);
  const grid = [...document.querySelectorAll(selectors.tiles)];
  // A one-page Store (no navigation) without grid tiles lists its products in its own modules only.
  const single = navigation.length === 0 && !!document.querySelector(selectors.header);
  const tiles = grid.length || !single ? grid : [...document.querySelectorAll(selectors.modules)];
  const asins = tiles.flatMap((tile) => {
    if (tile.querySelector('[class*="Sponsored"], [class*="sponsored"], a[href*="/sspa/"]')) {
      return [];
    }
    const attributes = [tile, ...tile.querySelectorAll("[data-asin]")]
      .map((node) => node.getAttribute("data-asin"))
      .filter((value): value is string => !!value);
    const anchors = [...tile.querySelectorAll("a[href]")].flatMap((anchor) => {
      const url = URL.parse(anchor.getAttribute("href") ?? "", "https://www.amazon.com");
      const asin = url?.pathname.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i)?.[1];
      return url?.origin === "https://www.amazon.com" && asin ? [asin] : [];
    });
    return [...attributes, ...anchors].map((asin) => asin.toUpperCase());
  });
  return {
    tileCount: tiles.length,
    asins: [...new Set(asins)],
    navigation: [...new Set(links.map((link) => link.getAttribute("href") ?? ""))],
    ready: navigation.length > 0 || single,
    // The markers of access-challenge.ts, as DOM: every Store page carries the words "Continue shopping" in its
    // inline widget strings ("STORES_WIDGET_ContinueShopping"), so page text marked all 501 Stores as challenged.
    blocked:
      !!document.querySelector(
        'form[action*="validateCaptcha"], form[action*="/checkpoint/"], form#checkpointForm, #captchacharacters',
      ) || /Robot Check/i.test(document.querySelector("title")?.textContent ?? ""),
    invalidTiles: grid.length > 0 && asins.length === 0,
  };
}
