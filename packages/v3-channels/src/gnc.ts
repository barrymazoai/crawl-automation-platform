import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { Parser } from "htmlparser2";
import { GncCaptureInputSchema, GncProductEvidenceSchema, GncCatalogPageSchema, GncUrlSchema, NetworkRouteSchema, type NetworkRoute,
  type GncCaptureInput, type GncProductEvidence, type GncCatalogPage } from "@crawl-automation/v3-contracts";
export const GNC_POLICY = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxNodes: 100000, maxDepth: 128, maxJsonObjects: 2000 });
export class GncError extends Error { constructor(readonly code: string) { super(code); this.name = "GncError"; } }
/** Trusted networking adapter owns authorization, DNS/redirect policy, session leases and cancellation.
 * One call only; no automatic fallback, retries, proxy switching, model calls or PDF loads. */
export interface GncPageReader {
  read(input: GncCaptureInput, signal: AbortSignal): Promise<{
    operationId: string; requestedUrl: string; finalUrl: string; binding: GncCaptureInput["binding"];
    status: number; contentType: string; bytes: Uint8Array;
    network?: NetworkRoute;
  }>;
}
export type GncReceivedPage = { input: GncCaptureInput; html: Uint8Array; sha256: string; network: NetworkRoute | null };
type Node = { tag: string; attrs: Record<string, string>; children: Node[]; parent: Node | null; text: string; start: number; end: number };
const ignored = new Set(["script", "style", "template", "noscript"]);
function tree(html: string) {
  const root: Node = { tag: "root", attrs: {}, children: [], parent: null, text: "", start: 0, end: html.length };
  let current = root, depth = 0, count = 0; const all: Node[] = [];
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (++count > GNC_POLICY.maxNodes || ++depth > GNC_POLICY.maxDepth) throw new GncError("GNC.PAGE_LIMIT");
      const n: Node = { tag, attrs, children: [], parent: current, text: "", start: parser.startIndex, end: html.length };
      current.children.push(n); all.push(n); current = n;
    },
    ontext(text) {
      if (++count > GNC_POLICY.maxNodes) throw new GncError("GNC.PAGE_LIMIT");
      const n: Node = { tag: "#text", attrs: {}, children: [], parent: current, text, start: parser.startIndex, end: parser.endIndex + 1 };
      current.children.push(n);
    },
    onclosetag() { current.end = parser.endIndex + 1; current = current.parent ?? root; depth--; },
  }, { decodeEntities: true });
  parser.end(html); return { root, all };
}
function text(n: Node): string { return ignored.has(n.tag) ? "" : n.tag === "#text" ? n.text : n.children.map(text).join(" "); }
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const ancestor = (n: Node, predicate: (v: Node) => boolean): boolean => predicate(n) || (n.parent ? ancestor(n.parent, predicate) : false);
const classHas = (n: Node, name: string) => (n.attrs.class ?? "").split(/\s+/).includes(name);
function gncUrl(raw: string, base: string) {
  let u: URL; try { u = new URL(raw, base); } catch { throw new GncError("GNC.URL_REJECTED"); }
  if (!GncUrlSchema.safeParse(u.href).success) throw new GncError("GNC.URL_REJECTED"); return u.href;
}
function productLink(raw: string, base: string) {
  const url = gncUrl(raw, base), path = new URL(url).pathname, match = path.match(/\/([\w-]+)\.html$/);
  if (!match || /\/search\b|demandware\.store/i.test(path)) return null;
  const sku = /^\d{6}$/.test(match[1]!) ? match[1]! : null;
  return { url, kind: sku ? "sku" as const : "family" as const, sku };
}
function parsedPage(html: string) {
  if (Buffer.byteLength(html) > GNC_POLICY.maxBytes) throw new GncError("GNC.PAGE_LIMIT");
  const doc = tree(html), body = clean(text(doc.root));
  // Library/script mentions of PerimeterX/captcha are not a challenge page.
  if (/Access to this page has been denied|Pardon Our Interruption|Press\s*(?:&|and)\s*Hold/i.test(body) ||
    doc.all.some(n => ["px-captcha", "_pxCaptcha"].includes(n.attrs.id ?? ""))) throw new GncError("GNC.ACCESS_CHALLENGE");
  return doc;
}
export function parseGncCatalog(html: string, url: string): GncCatalogPage {
  gncUrl(url, url); const doc = parsedPage(html), entries = new Map<string, NonNullable<ReturnType<typeof productLink>>>();
  for (const n of doc.all) if (n.tag === "a" && n.attrs.href && ancestor(n, p => classHas(p, "product-tile"))) {
    const link = productLink(n.attrs.href, url); if (link) entries.set(link.url, link);
  }
  if (!entries.size) throw new GncError("GNC.CATALOG_UNVERIFIED");
  if (entries.size > 1000) throw new GncError("GNC.PAGE_LIMIT");
  const next = new Set<string>();
  for (const n of doc.all) {
    const raw = n.attrs["data-grid-url"] && /load-more/i.test(n.attrs.class ?? "") ? n.attrs["data-grid-url"] : n.attrs.rel === "next" ? n.attrs.href : null;
    if (raw) next.add(gncUrl(raw, url));
  }
  if (next.size > 1 || next.has(url)) throw new GncError("GNC.PAGINATION_CONFLICT");
  const nextUrl = [...next][0] ?? null;
  // Mapped desktop Brand template only. Missing pagination alone is never evidence of completeness.
  const rootUrl=new URL(url), counters=doc.all.filter(n=>classHas(n,"search-result-bookmarks"));
  const totals=doc.all.filter(n=>classHas(n,"product-custom-count"));
  const tiles=doc.all.filter(n=>classHas(n,"product-tile"));
  const count=counters.length===1?Number(counters[0]!.attrs["data-gtmsearchcount"]):NaN;
  const countProof=!nextUrl&&!rootUrl.search&&/^\/brands\/[a-z0-9-]+\/$/.test(rootUrl.pathname)&&
    Number.isInteger(count)&&count>0&&count<=100&&totals.length===1&&Number(totals[0]!.attrs["data-actual-productcount"])===count&&
    clean(text(counters[0]!)).includes(`Products (${count})`)&&tiles.length===count&&entries.size===count&&
    tiles.every(n=>ancestor(n,p=>p.attrs.id==="search-result-items")&&/^\d{6}$/.test(n.attrs["data-itemid"]??""))&&
    new Set(tiles.map(n=>n.attrs["data-itemid"])).size===count&&[...entries.values()].every(e=>e.sku&&tiles.some(n=>n.attrs["data-itemid"]===e.sku))
    ?{codec:"gnc-single-page-count/1" as const,count}:undefined;
  return GncCatalogPageSchema.parse({ url, entries: [...entries.values()], nextUrl, completion: nextUrl ? "more" : "unverified_end",...(countProof?{countProof}:{}) });
}
type Json = Record<string, unknown>;
const record = (x: unknown): x is Json => Boolean(x && typeof x === "object" && !Array.isArray(x));
const value = (x: unknown) => typeof x === "string" && x.trim() ? x.trim() : null;
export function parseGncProduct(html: string, url: string, sku: string): GncProductEvidence {
  if (!/^\d{6}$/.test(sku) || !new URL(gncUrl(url, url)).pathname.endsWith(`/${sku}.html`)) throw new GncError("GNC.SKU_CONFLICT");
  const doc = parsedPage(html), products: Json[] = [], groups: Json[] = []; let count = 0;
  const visit = (x: unknown, depth = 0) => {
    if (++count > GNC_POLICY.maxJsonObjects || depth > 20) throw new GncError("GNC.JSON_LIMIT");
    if (Array.isArray(x)) { for (const y of x) visit(y, depth + 1); return; }
    if (!record(x)) return;
    if ((Array.isArray(x["@type"]) ? x["@type"] : [x["@type"]]).includes("Product")) products.push(x);
    if ((Array.isArray(x["@type"]) ? x["@type"] : [x["@type"]]).includes("ProductGroup")) groups.push(x);
    for (const key of ["@graph", "hasVariant"]) if (x[key]) visit(x[key], depth + 1);
  };
  for (const n of doc.all) if (n.tag === "script" && n.attrs.type === "application/ld+json") {
    let json: unknown; try { json = JSON.parse(n.children.map(c => c.text).join("")); } catch { throw new GncError("GNC.JSON_INVALID"); }
    visit(json);
  }
  const matches = products.filter(p => String(p.sku ?? "") === sku);
  if (!matches.length) throw new GncError("GNC.SKU_UNVERIFIED");
  const product = matches[0]!;
  if (matches.some(p => !equal(p, product))) throw new GncError("GNC.SKU_AMBIGUOUS");
  const title = value(product.name); if (!title) throw new GncError("GNC.TITLE_MISSING");
  if (record(product.offers) && value(product.offers.url) && !new URL(gncUrl(String(product.offers.url), url)).pathname.endsWith(`/${sku}.html`)) throw new GncError("GNC.SKU_CONFLICT");
  const uniqueRoot = (id: string) => {
    const found = doc.all.filter(n => n.attrs.id === id); if (found.length > 1) throw new GncError("GNC.DOM_AMBIGUOUS"); return found[0];
  };
  const facts = uniqueRoot("productIngredientsAccordionContent"), details = uniqueRoot("productDetailsAccordionContent");
  // Preserve exact DOM evidence even when incomplete; no pre-model completeness heuristic discards it.
  const factsHtml = facts && clean(text(facts)) ? html.slice(facts.start, facts.end) : null;
  const variants = new Set<string>();
  const siblings = groups.flatMap(g => {
    const members = Array.isArray(g.hasVariant) ? g.hasVariant.filter(record) : [];
    return members.some(p => String(p.sku ?? "") === sku) ? members : [];
  });
  for (const p of siblings) if (String(p.sku ?? "") !== sku && record(p.offers) && value(p.offers.url)) {
    const link = productLink(String(p.offers.url), url);
    if (!link?.sku || link.sku !== String(p.sku ?? "")) throw new GncError("GNC.SKU_CONFLICT");
    variants.add(link.url);
  }
  for (const n of doc.all) if (ancestor(n, p => classHas(p, "product-variations") || p.attrs["data-attribute-id"] !== undefined)) {
    const raw = n.attrs["data-url"] ?? n.attrs.href;
    if (raw) { const link = productLink(raw, url); if (link?.sku && link.sku !== sku) variants.add(link.url); }
  }
  const images = new Map<string, GncProductEvidence["imageCandidates"][number]>();
  const addImage = (raw: unknown, basis: "sku-jsonld" | "product-gallery") => {
    if (typeof raw !== "string") return;
    let u: URL; try { u = new URL(raw, url); } catch { throw new GncError("GNC.IMAGE_URL_INVALID"); }
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || /\.pdf$/i.test(u.pathname)) return;
    images.set(u.href, { url: u.href, basis, verifiedOriginal: false });
  };
  for (const image of Array.isArray(product.image) ? product.image : [product.image]) addImage(image, "sku-jsonld");
  for (const n of doc.all) {
    if (n.tag !== "img" || ancestor(n, p => ignored.has(p.tag) || classHas(p, "product-tile") || classHas(p, "recommendation") || classHas(p, "recommendations") ||
      (p.attrs["data-pid"] !== undefined && p.attrs["data-pid"] !== sku))) continue;
    const knownGallery = ancestor(n, p => classHas(p, "product-image-container") || p.attrs.id === "product-images");
    // Current GNC desktop gallery uses a thumbnail grid outside the old container.
    // Require the verified product title as well as that exact container; never infer ownership from a filename SKU.
    const currentGallery = ancestor(n, p => classHas(p, "product-thumbnails-grid")) &&
      clean(n.attrs.alt ?? "").replace(/\s*\|\s*GNC$/, "").trim() === clean(title);
    if (knownGallery || currentGallery) addImage(n.attrs["data-zoom-url"] ?? n.attrs["data-src"] ?? n.attrs.src, "product-gallery");
  }
  if (images.size > 100 || variants.size > 200) throw new GncError("GNC.PAGE_LIMIT");
  const brandRaw = value(record(product.brand) ? product.brand.name : product.brand);
  return GncProductEvidenceSchema.parse({ sku, url, title, brandRaw, factsHtml,
    detailsHtml: details ? html.slice(details.start, details.end) : null, variantUrls: [...variants], imageCandidates: [...images.values()],
    warnings: [...(!factsHtml ? ["GNC.FACTS_DOM_MISSING"] : []), "GNC.GALLERY_UNVERIFIED", ...(!brandRaw ? ["GNC.BRAND_MISSING"] : [])] });
}
export class GncAdapter {
  constructor(private readonly reader: GncPageReader) {}
  async capture(raw: unknown, signal: AbortSignal, retain?: (page: GncReceivedPage) => Promise<void>) {
    const input = GncCaptureInputSchema.parse(raw); signal.throwIfAborted();
    const page = await this.reader.read(input, signal);
    if (page.operationId !== input.operationId || page.requestedUrl !== input.url || !equal(page.binding, input.binding)) throw new GncError("GNC.SESSION_CONFLICT");
    const network = page.network === undefined ? null : NetworkRouteSchema.parse(page.network);
    if (network && network.egressId !== input.binding.egressId) throw new GncError("GNC.SESSION_CONFLICT");
    const url = gncUrl(page.finalUrl, input.url);
    if (url !== input.url) throw new GncError("GNC.REDIRECT_UNVERIFIED");
    if (!Number.isInteger(page.status) || page.status < 100 || page.status > 599) throw new GncError("GNC.HTTP_STATUS");
    const statusError = [403, 406, 429].includes(page.status) ? "GNC.ACCESS_CHALLENGE" :
      [404, 410].includes(page.status) ? "GNC.NOT_FOUND" : page.status !== 200 ? "GNC.HTTP_STATUS" : null;
    if (!/^text\/html(?:\s*;|$)/i.test(page.contentType)) throw new GncError(statusError ?? "GNC.NOT_HTML");
    const charset = page.contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
    if (charset && !/^utf-?8$/i.test(charset)) throw new GncError("GNC.ENCODING");
    if (!page.bytes.length || page.bytes.length > GNC_POLICY.maxBytes) throw new GncError("GNC.PAGE_LIMIT");
    let html: string; try { html = new TextDecoder("utf-8", { fatal: true }).decode(page.bytes); } catch { throw new GncError("GNC.ENCODING"); }
    // Retain bounded, owned HTML even for an error response. A received page is not a
    // successful acquisition: no parsed evidence/completion is created until all checks pass.
    if (retain) await retain({ input, network, html: Buffer.from(page.bytes), sha256: createHash("sha256").update(page.bytes).digest("hex") });
    signal.throwIfAborted();
    if (statusError) {
      // Real browser challenge pages can return 307. Inspect their body before the
      // generic status error, without following redirects or treating them as products.
      parsedPage(html);
      throw new GncError(statusError);
    }
    const data = input.kind === "product" ? parseGncProduct(html, url, input.sku) : parseGncCatalog(html, url);
    return { input, data, network, html: page.bytes, sha256: createHash("sha256").update(page.bytes).digest("hex"), artifactDurable: false as const };
  }
}
