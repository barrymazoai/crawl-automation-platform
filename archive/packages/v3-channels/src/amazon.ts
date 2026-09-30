import { ChannelCatalogEvidenceSchema, ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import { ChannelError, parseHtml, uniqueId, within, cleanText, channelUrl, imageUrl, rejectChallenge } from "./html-evidence.js";
const asinPattern = /^[A-Z0-9]{10}$/;
function productUrl(raw: string, base: string) {
  const u = channelUrl(raw, "amazon", base), asin = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/)?.[1];
  return asin ? { asin, url: `${u.origin}/dp/${asin}` } : null;
}
/** Pure selected-ASIN extraction. Recommendation carousels are outside selected-product roots. */
export function parseAmazonProduct(html: string, url: string, asin: string) {
  if (!asinPattern.test(asin) || productUrl(url, url)?.asin !== asin) throw new ChannelError("AMAZON.ASIN_CONFLICT");
  const doc = parseHtml(html); rejectChallenge(doc);
  const main = uniqueId(doc.all, "ppd"), identity = uniqueId(doc.all, "ASIN");
  // Live Amazon pages also have a warranty INPUT named productTitle outside #ppd.
  // Scope the heading lookup to the product root; do not select the first global duplicate.
  const titles = main ? doc.all.filter(n => n.attrs.id === "productTitle" && within(n, p => p === main)) : [];
  if (titles.length > 1) throw new ChannelError("CHANNEL.IDENTITY_CONFLICT");
  const title = titles[0] ?? null;
  if (!main || !identity || identity.attrs.value !== asin || !title || !within(title, n => n === main)) throw new ChannelError("AMAZON.PRODUCT_UNVERIFIED");
  const brand = uniqueId(doc.all, "bylineInfo"), gallery = uniqueId(doc.all, "imageBlock"), twister = uniqueId(doc.all, "twister");
  const imageCandidates = new Map<string, { url: string; variantId: null; basis: "selected-gallery"; verifiedOriginal: false }>();
  if (gallery && within(gallery, n => n === main)) for (const n of doc.all.filter(n => n.tag === "img" && within(n, p => p === gallery))) {
    const urls: string[] = [];
    if (n.attrs["data-old-hires"]) urls.push(n.attrs["data-old-hires"]!);
    if (n.attrs["data-a-dynamic-image"]) {
      let sizes: unknown; try { sizes = JSON.parse(n.attrs["data-a-dynamic-image"]!); } catch { throw new ChannelError("AMAZON.GALLERY_INVALID"); }
      if (!sizes || typeof sizes !== "object" || Array.isArray(sizes) || Object.keys(sizes).length > 100) throw new ChannelError("AMAZON.GALLERY_INVALID");
      urls.push(...Object.keys(sizes));
    }
    if (!urls.length && n.attrs.src) urls.push(n.attrs.src);
    for (const raw of urls) { const u = imageUrl(raw, url); imageCandidates.set(u, { url: u, variantId: null, basis: "selected-gallery", verifiedOriginal: false }); }
  }
  const variants = new Map<string, { listingId: string; variantId: null; url: string; title: string | null }>();
  if (twister && within(twister, n => n === main)) for (const n of doc.all.filter(n => n.tag === "a" && n.attrs.href && within(n, p => p === twister))) {
    const link = productUrl(n.attrs.href!, url); if (link && link.asin !== asin) variants.set(link.asin, { listingId: link.asin, variantId: null, url: link.url, title: cleanText(n) || null });
  }
  const details = ["feature-bullets", "productDescription", "important-information"].map(id => uniqueId(doc.all, id)).filter(n => n && within(n, p => p === main));
  const selected = uniqueId(doc.all, "important-information");
  return ChannelProductEvidenceSchema.parse({ codec: "channel-product/1", channel: "amazon", listingId: asin, variantId: null,
    url: productUrl(url, url)!.url, title: cleanText(title), brandRaw: brand && within(brand, n => n === main) ? cleanText(brand) : null,
    variantOptions: [], variants: [...variants.values()], detailsHtml: details.map(n => html.slice(n!.start, n!.end)).join("\n") || null,
    factsCandidates: selected && within(selected, n => n === main) ? [{ field: "important-information", html: html.slice(selected.start, selected.end), scope: "selected-product" }] : [],
    imageCandidates: [...imageCandidates.values()], warnings: ["CHANNEL.PROFILE_LIVE_UNVERIFIED", "AMAZON.GALLERY_REPLAY_REQUIRED", ...(twister ? ["AMAZON.VARIANT_ENUMERATION_UNVERIFIED"] : [])] });
}
/** Store-page discovery only. Search limits and absence of a Next link never prove closure. */
export function parseAmazonStore(html: string, url: string) {
  const u = channelUrl(url, "amazon"); if (!/^\/(?:-\/[a-z]{2}\/)?stores\//.test(u.pathname)) throw new ChannelError("AMAZON.STORE_REQUIRED");
  const doc = parseHtml(html); rejectChallenge(doc); const root = uniqueId(doc.all, "stores");
  if (!root) throw new ChannelError("AMAZON.STORE_TEMPLATE_UNVERIFIED");
  const entries = new Map<string, { listingId: string; variantId: null; url: string; title: string | null }>();
  for (const n of doc.all.filter(n => n.tag === "a" && n.attrs.href && within(n, p => p === root))) {
    const tile = (() => { let p = n; while (p !== root) { if (p.attrs["data-asin"]) return p; if (!p.parent) break; p = p.parent; } return null; })();
    if (!tile || /^(?:true|1)$/i.test(tile.attrs["data-sponsored"] ?? "") || /\bSponsored\b/.test(cleanText(tile))) continue;
    const link = productUrl(n.attrs.href!, u.href); if (!link) continue;
    if (link.asin !== tile.attrs["data-asin"]) throw new ChannelError("AMAZON.ASIN_CONFLICT");
    entries.set(link.asin, { listingId: link.asin, variantId: null, url: link.url, title: cleanText(n) || null });
  }
  if (!entries.size) throw new ChannelError("AMAZON.CATALOG_UNVERIFIED");
  const next = new Set(doc.all.filter(n => n.tag === "a" && n.attrs.rel === "next" && within(n, p => p === root)).map(n => channelUrl(n.attrs.href!, "amazon", url).href));
  if (next.size > 1 || next.has(url)) throw new ChannelError("AMAZON.PAGINATION_CONFLICT");
  const nextUrl = [...next][0] ?? null;
  if (nextUrl && new URL(nextUrl).pathname !== u.pathname) throw new ChannelError("AMAZON.PAGINATION_CONFLICT");
  return ChannelCatalogEvidenceSchema.parse({ codec: "channel-catalog/1", channel: "amazon", url, entries: [...entries.values()], nextUrl,
    completion: nextUrl ? "more" : "unverified_end", reportedTotal: null, warnings: ["CHANNEL.PROFILE_LIVE_UNVERIFIED", "AMAZON.STORE_COVERAGE_UNVERIFIED"] });
}
