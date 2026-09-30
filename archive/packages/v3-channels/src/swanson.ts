import { z } from "zod";
import { ChannelCatalogEvidenceSchema, ChannelProductEvidenceSchema, type ChannelProductEvidence } from "@crawl-automation/v3-contracts";
import { ChannelError, CHANNEL_LIMITS, channelUrl, imageUrl } from "./html-evidence.js";
const id = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]).transform(String);
const variant = z.object({ id, title: z.string().max(4000), sku: z.string().nullable().optional(), options: z.array(z.string()).max(10).optional(),
  featured_image: z.object({ src: z.string() }).nullable().optional() });
const product = z.object({ id, handle: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), title: z.string().min(1).max(4000), vendor: z.string().max(1000),
  description: z.string().max(2000000), variants: z.array(variant).min(1).max(200), images: z.array(z.string()).max(100) });
/** Decode complete JSON string literals, not a regex capture ending at an escaped quote.
 * Caller must bind the supplied product fragment to source evidence; this does not navigate or infer scope. */
export function parseSwansonFactsFragment(fragment: string) {
  if (Buffer.byteLength(fragment) > CHANNEL_LIMITS.bytes) throw new ChannelError("SWANSON.PAGE_LIMIT");
  const found = new Map<string, string>();
  const keys = /"(supplementFacts|nutritionFacts|productFacts|drugFacts|otherIngredients|ingredients)"\s*:\s*"/g;
  for (let m; (m = keys.exec(fragment));) {
    const start = keys.lastIndex - 1; let end = start + 1, closed = false;
    for (; end < fragment.length; end++) { if (fragment[end] === "\\") { end++; continue; } if (fragment[end] === '"') { closed = true; break; } }
    if (!closed) throw new ChannelError("SWANSON.TRUNCATED_FACTS");
    let html: string; try { html = JSON.parse(fragment.slice(start, end + 1)); } catch { throw new ChannelError("SWANSON.INVALID_FACTS"); }
    keys.lastIndex = end + 1;
    if (html.length > 500000) throw new ChannelError("SWANSON.PAGE_LIMIT");
    if (!html.trim() || /^(?:<[^>]*>|\s|Supplement Facts|Nutrition Facts|Ingredients|Other Ingredients)*$/i.test(html)) continue;
    if (found.has(m[1]!) && found.get(m[1]!) !== html) throw new ChannelError("SWANSON.AMBIGUOUS_FACTS");
    found.set(m[1]!, html);
  }
  return [...found].map(([field, html]) => ({ field, html, scope: "product-unassigned-variant" as const }));
}
/** One selected variant; general product gallery/facts are deliberately NOT assigned to all variants. */
export function parseSwansonProduct(raw: unknown, url: string, variantId: string, factsFragment = "") {
  const u = channelUrl(url, "swanson"), p = product.parse(raw);
  if (u.pathname !== `/products/${p.handle}` || u.searchParams.getAll("variant").length !== 1 || u.searchParams.get("variant") !== variantId || [...u.searchParams.keys()].some(k => k !== "variant")) throw new ChannelError("SWANSON.VARIANT_CONFLICT");
  if (new Set(p.variants.map(v => v.id)).size !== p.variants.length) throw new ChannelError("SWANSON.VARIANT_CONFLICT");
  const selected = p.variants.find(v => v.id === variantId); if (!selected) throw new ChannelError("SWANSON.VARIANT_CONFLICT");
  const images: ChannelProductEvidence["imageCandidates"] = [...new Set(p.images)].map(v => ({ url: imageUrl(v, u.href), variantId: p.variants.length === 1 ? variantId : null,
    basis: "product-gallery" as const, verifiedOriginal: false as const }));
  if (selected.featured_image) {
    const featured = imageUrl(selected.featured_image.src, u.href);
    const duplicate = images.findIndex(i => i.url === featured); if (duplicate >= 0) images.splice(duplicate, 1);
    images.unshift({ url: featured, variantId, basis: "variant-featured", verifiedOriginal: false });
  }
  return ChannelProductEvidenceSchema.parse({ codec: "channel-product/1", channel: "swanson", listingId: p.id, variantId, url: u.href,
    title: p.title, brandRaw: p.vendor || null, variantOptions: selected.options ?? [selected.title],
    variants: p.variants.map(v => ({ listingId: p.id, variantId: v.id, url: `${u.origin}/products/${p.handle}?variant=${v.id}`, title: v.title })),
    detailsHtml: p.description || null, factsCandidates: parseSwansonFactsFragment(factsFragment), imageCandidates: images,
    warnings: ["CHANNEL.PROFILE_LIVE_UNVERIFIED", ...(p.variants.length > 1 ? ["SWANSON.VARIANT_GALLERY_REVIEW_REQUIRED"] : [])] });
}
const variationData = z.object({ url: z.string(), product_id: id.optional(), variant_id: id.optional(), description: z.string().optional() });
const result = z.object({ value: z.string().optional(), data: variationData, variations: z.array(z.object({ data: variationData })).max(200).optional() });
/** Constructor response pagination count refers to parent results, not expanded variants. Never invent completeness. */
export function parseSwansonCatalog(raw: unknown, pageUrl: string, nextUrl: string | null) {
  const page = channelUrl(pageUrl, "swanson"), next = nextUrl ? channelUrl(nextUrl, "swanson") : null;
  if (next && (next.href === page.href || next.pathname !== page.pathname)) throw new ChannelError("SWANSON.PAGINATION_CONFLICT");
  const parsed = z.object({ response: z.object({ results: z.array(result).max(200), total_num_results: z.number().int().nonnegative() }) }).parse(raw);
  const entries = new Map<string, { listingId: string; variantId: string | null; url: string; title: string | null }>();
  for (const r of parsed.response.results) for (const d of [r.data, ...(r.variations ?? []).map(v => v.data)]) {
    const path = d.url.startsWith("products/") ? `/${d.url}` : d.url.startsWith("http") || d.url.startsWith("/") ? d.url : `/products/${d.url}`;
    const u = channelUrl(path, "swanson", pageUrl);
    const handle = u.pathname.match(/^\/products\/([a-z0-9-]+)$/)?.[1]; if (!handle) throw new ChannelError("SWANSON.PRODUCT_URL_UNVERIFIED");
    const variantId = d.variant_id ?? null;
    if (u.searchParams.getAll("variant").length > 1 || u.searchParams.has("variant") && u.searchParams.get("variant") !== variantId) throw new ChannelError("SWANSON.VARIANT_CONFLICT");
    if (variantId) u.searchParams.set("variant", variantId);
    if ([...u.searchParams.keys()].some(k => k !== "variant") || !variantId && u.searchParams.has("variant")) throw new ChannelError("SWANSON.VARIANT_CONFLICT");
    const listingId = d.product_id ?? r.data.product_id;
    if (!listingId) throw new ChannelError("SWANSON.IDENTITY_UNVERIFIED");
    if (r.data.product_id && listingId !== r.data.product_id) throw new ChannelError("SWANSON.IDENTITY_CONFLICT");
    const key = `${listingId}:${variantId ?? "family"}`;
    const entry = { listingId, variantId, url: u.href, title: d.description ?? r.value ?? null };
    const old = entries.get(key); if (old && old.url !== entry.url || [...entries.values()].some(e => e.url === entry.url && e.listingId !== listingId)) throw new ChannelError("SWANSON.IDENTITY_CONFLICT"); entries.set(key, entry);
  }
  return ChannelCatalogEvidenceSchema.parse({ codec: "channel-catalog/1", channel: "swanson", url: pageUrl, entries: [...entries.values()], nextUrl,
    reportedTotal: parsed.response.total_num_results, completion: nextUrl ? "more" : "unverified_end", warnings: ["CHANNEL.PROFILE_LIVE_UNVERIFIED", "SWANSON.PARENT_COUNT_NOT_VARIANT_COUNT"] });
}
