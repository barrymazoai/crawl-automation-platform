import { parseHTML } from "linkedom";

/**
 * Owner 2026-10-24: substitute only an image declared by this page's Product scope.
 * Identity requires equal origin, query and pathname outside an explicit resized_W_H_ token;
 * both declared dimensions must be at least as large, and one must be larger.
 */
export function declaredProductGallery(html, pageUrl, galleryUrls) {
  const document = parseHTML(html).document;
  const declared = [...microdataImages(document), ...jsonLdImages(document)]
    .map(value => absoluteImage(value, pageUrl)).filter(Boolean);
  const replacements = [];
  const seen = new Set();
  const urls = galleryUrls.flatMap(galleryUrl => {
    const current = absoluteImage(galleryUrl, pageUrl);
    if (!current) return [galleryUrl];
    const larger = declared.filter(url => sameSizedImage(current, url))
      .sort((a, b) => sizeArea(b) - sizeArea(a))[0];
    const chosen = larger ?? galleryUrl;
    if (larger && larger !== galleryUrl) replacements.push({ galleryUrl, declaredUrl: larger,
      basis: "product-structured-data" });
    return seen.has(chosen) ? [] : (seen.add(chosen), [chosen]);
  });
  return { urls, replacements };
}

function microdataImages(document) {
  return [...document.querySelectorAll('[itemscope][itemtype]')]
    .filter(node => /^https?:\/\/schema\.org\/Product\/?$/i.test(node.getAttribute("itemtype") ?? ""))
    .flatMap(product => [...product.querySelectorAll('[itemprop~="image"]')]
      .filter(node => node.closest('[itemscope][itemtype]') === product)
      .map(node => node.getAttribute("content") ?? node.getAttribute("href") ?? node.getAttribute("src"))
      .filter(Boolean));
}

function jsonLdImages(document) {
  const products = [];
  const visit = (value, depth = 0) => {
    if (depth > 6 || !value) return;
    if (Array.isArray(value)) return value.forEach(item => visit(item, depth + 1));
    if (typeof value !== "object") return;
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some(type => type === "Product"
      || typeof type === "string" && /^https?:\/\/schema\.org\/Product\/?$/i.test(type))) products.push(value);
    visit(value["@graph"], depth + 1);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent ?? "")); } catch { /* malformed block */ }
  }
  return products.flatMap(product => (Array.isArray(product.image) ? product.image : [product.image])
    .map(image => typeof image === "string" ? image : image?.url ?? image?.contentUrl)
    .filter(value => typeof value === "string"));
}

function absoluteImage(value, pageUrl) {
  try {
    const url = new URL(value, pageUrl);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function sized(url) {
  const parsed = new URL(url);
  const match = /resized_(\d{2,5})_(\d{2,5})_/i.exec(parsed.pathname);
  if (!match) return null;
  return { origin: parsed.origin, query: parsed.search, before: parsed.pathname.slice(0, match.index),
    after: parsed.pathname.slice(match.index + match[0].length), width: Number(match[1]),
    height: Number(match[2]) };
}

function sameSizedImage(left, right) {
  const a = sized(left); const b = sized(right);
  return a && b && a.origin === b.origin && a.query === b.query && a.before === b.before
    && a.after === b.after && b.width >= a.width && b.height >= a.height
    && (b.width > a.width || b.height > a.height);
}

function sizeArea(url) {
  const value = sized(url);
  return value ? value.width * value.height : 0;
}
