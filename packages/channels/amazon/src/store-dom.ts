import type { AmazonDocument } from "./dom.js";

// These Store selectors also appear in the retained legacy Amazon catalog reader. Global Amazon
// navigation, recommendations and arbitrary /dp links are deliberately outside these scopes.
export const STORE_SELECTORS = {
  navigation:
    'nav[class*="Navigation__navBar__"], [role="navigation"][aria-label$="Navigation Bar"]',
  tiles:
    'li[class*="ProductGridItem__itemOuter__"], [class*="ProductCard__"], [data-testid="product-tile"]',
  grid: '[class*="ProductGrid__grid__"], [data-testid="product-grid"]',
};

/** Self-contained so the same read-only projection runs in Ego and over retained HTML. */
export function inspectStoreDom(document: AmazonDocument, selectors: typeof STORE_SELECTORS) {
  const navigation = [...document.querySelectorAll(selectors.navigation)];
  const links = navigation.flatMap((nav) => [...nav.querySelectorAll("a[href]")]);
  const tiles = [...document.querySelectorAll(selectors.tiles)];
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
    ready: navigation.length > 0,
    blocked:
      !!document.querySelector('form[action*="validateCaptcha"], #captchacharacters') ||
      /Robot Check|Enter the characters you see below|Continue shopping/i.test(
        document.body?.textContent ?? "",
      ),
    invalidTiles: tiles.length > 0 && asins.length === 0,
  };
}
