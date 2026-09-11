import { ChannelProductEvidenceSchema, SwansonRenderedProductSchema, type Observation } from "@crawl-automation/v3-contracts";
import { ChannelError, channelUrl } from "./html-evidence.js";

/** These paths were observed in the live storefront, unlike the provisional /products JSON adapter. */
export function swansonProductAddress(raw: string) {
  const u = channelUrl(raw, "swanson");
  const handle = u.pathname.match(/^\/(?:collections\/[a-z0-9-]+\/)?p\/([a-z0-9][a-z0-9-]*)$/)?.[1];
  if (!handle || [...u.searchParams.keys()].some(k => k !== "variant") || u.searchParams.getAll("variant").length > 1 ||
    u.searchParams.has("variant") && !/^\d+$/.test(u.searchParams.get("variant")!)) throw new ChannelError("SWANSON.PRODUCT_URL_UNVERIFIED");
  return { url: u, handle, variantId: u.searchParams.get("variant") };
}
const htmlText = (text: string) => `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
/** Enumerate only explicit, directly linked choices. Never synthesize combinations or
 * copy the selected product's numeric ID/gallery to its connected products. */
export function swansonVariantChoices(raw: unknown) {
  const p = SwansonRenderedProductSchema.parse(raw), current = swansonProductAddress(p.canonicalUrl);
  if(p.selectedForms.length!==1||p.selectedForms[0]!.variantIds.length!==1)throw new ChannelError("SWANSON.IDENTITY_UNVERIFIED");
  const variantId=p.selectedForms[0]!.variantIds[0]!;
  if(!p.variantPicker||p.variantPicker.options.length===0){
    if(p.variantPicker?.unmapped)throw new ChannelError("SWANSON.VARIANT_OPTIONS_UNVERIFIED");
    return {coverage:"selected-only" as const,choices:[{url:p.url,handle:current.handle,variantId,label:p.title,available:true}]};
  }
  if(p.variantPicker.unmapped||new Set(p.variantPicker.options.map(o=>o.group)).size!==1)throw new ChannelError("SWANSON.VARIANT_OPTIONS_UNVERIFIED");
  const selected=p.variantPicker.options.filter(o=>o.selected), seen=new Set<string>();
  if(selected.length!==1||selected[0]!.variantId!==variantId||swansonProductAddress(selected[0]!.url).handle!==current.handle)throw new ChannelError("SWANSON.VARIANT_CONFLICT");
  const choices=p.variantPicker.options.map(o=>{
    const a=swansonProductAddress(o.url);
    if(a.url.hash||a.url.search||a.url.pathname!==`/p/${a.handle}`||seen.has(o.variantId))throw new ChannelError("SWANSON.VARIANT_CONFLICT");
    // Observed storefront selection navigates to connected URL + variant ID.
    // The bare connected path can render a non-product page on a fresh navigation.
    a.url.searchParams.set("variant",o.variantId);
    seen.add(o.variantId);return {url:a.url.href,handle:a.handle,variantId:o.variantId,label:o.label,available:o.available};
  });
  if(new Set(choices.map(o=>o.url)).size!==choices.length)throw new ChannelError("SWANSON.VARIANT_CONFLICT");
  return {coverage:"declared-options" as const,choices};
}
/** Pure conversion of retained public DOM evidence. Does not download, enumerate variants or infer nutrients. */
export function parseSwansonRenderedProduct(raw: unknown, expectedUrl: string, owner: Pick<Observation, "listingId" | "variantId">) {
  const p = SwansonRenderedProductSchema.parse(raw), actual = swansonProductAddress(p.url), expected = swansonProductAddress(expectedUrl);
  const canonical = swansonProductAddress(p.canonicalUrl);
  if (canonical.url.pathname !== `/p/${actual.handle}` || canonical.url.search || expected.handle !== actual.handle ||
    expected.variantId && expected.variantId !== actual.variantId) throw new ChannelError("SWANSON.IDENTITY_CONFLICT");
  // A single selected form is evidence of selection, NOT evidence that the product has no other variants.
  if (p.selectedForms.length !== 1 || p.selectedForms[0]!.variantIds.length !== 1) throw new ChannelError("SWANSON.IDENTITY_UNVERIFIED");
  const form = p.selectedForms[0]!, variantId = form.variantIds[0]!;
  if (owner.listingId !== form.productId || owner.variantId !== variantId || actual.variantId && actual.variantId !== variantId ||
    expected.variantId && expected.variantId !== variantId) throw new ChannelError("SWANSON.VARIANT_CONFLICT");
  const sections = new Map<string, string>();
  for (const s of p.sections) {
    if (sections.has(s.heading)) throw new ChannelError("SWANSON.AMBIGUOUS_FACTS");
    const text = s.text.trim().replace(new RegExp(`^${s.heading}\\s*`), "").trim();
    sections.set(s.heading, text);
  }
  const images = new Set<string>();
  for (const image of p.gallery) {
    const u = new URL(image.url);
    if (u.protocol !== "https:" || u.hostname !== "www.swansonvitamins.com" || u.port || u.username || u.password || u.hash ||
      !u.pathname.startsWith("/cdn/shop/files/") || [...u.searchParams.keys()].some(k => !["v", "width"].includes(k)))
      throw new ChannelError("CHANNEL.IMAGE_URL_REJECTED");
    images.add(u.href); // preserve the actual DOM URL, never manufacture a larger image URL
  }
  const facts = sections.get("Product Facts");
  return ChannelProductEvidenceSchema.parse({ codec: "channel-product/1", channel: "swanson", listingId: form.productId, variantId,
    url: p.url, title: p.title, brandRaw: null, variantOptions: [], variants: [],
    detailsHtml: sections.get("Product Details") ? htmlText(sections.get("Product Details")!) : null,
    factsCandidates: facts && !/^(?:Supplement Facts|Nutrition Facts|Ingredients|\s)*$/i.test(facts)
      ? [{ field: "productFacts", html: htmlText(facts), scope: "selected-product" }] : [],
    imageCandidates: [...images].map(url => ({ url, variantId, basis: "selected-gallery", verifiedOriginal: false })),
    warnings: ["SWANSON.VARIANT_ENUMERATION_UNVERIFIED", "CHANNEL.DOM_TEXT_PROJECTION"],
  });
}
