import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { AmazonRenderedProductSchema, type AmazonRenderedProduct } from "@crawl-automation/v3-contracts";
import { abortable, transportAddress, permittedUrl, systemDns, requireCapability, NetworkError,
  type DnsResolver, type HttpRoute, type Response } from "@crawl-automation/v3-acquisition";
import { amazonProductExpression } from "./amazon-ego.js";
import { amazonProductAddress, parseAmazonRenderedProduct } from "./amazon-rendered.js";
import { ChannelError } from "./html-evidence.js";
import { AmazonHtmlArchive, type ArchivedAmazonHtml, type AmazonHtmlFetchGate } from './amazon-html-archive.js';

/** Bounded raw HTML read of one public product page. No JS execution, cookies, redirects or retries. */
export const AMAZON_HTTP_POLICY = Object.freeze({ timeoutMs: 75000, maxBytes: 6 * 1024 * 1024, redirects: 0,
  origins: Object.freeze(["https://www.amazon.com"]) });
const CHALLENGE = /validateCaptcha|api-services-support@amazon\.com|Robot Check|Enter the characters you see below/;
const ASIN = /^[A-Z0-9]{10}$/;
type FetchedVia = NonNullable<AmazonRenderedProduct["fetchedVia"]>;
type Gallery = { url: string; alt: string }[];

/** `'colorImages': { 'initial': A.$.parseJSON('[...]') }` inside the ImageBlockATF script. The array items are
 * JSON; the surrounding string is single-quoted JS with backslash escapes. hiRes is preferred, then large. */
export function amazonStaticGallery(html: string): Gallery {
  const m = html.match(/'colorImages':\s*\{\s*'initial':\s*A\.\$\.parseJSON\('((?:[^'\\]|\\.)*)'\)/);
  if (!m) return [];
  let items: unknown;
  try { items = JSON.parse(m[1]!.replace(/\\(.)/g, "$1")); } catch { return []; }
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>(), out: Gallery = [];
  for (const item of items as Record<string, unknown>[]) {
    const url = [item.hiRes, item.large].find(v => typeof v === "string" && v.startsWith("https://m.media-amazon.com/images/I/")) as string | undefined;
    if (!url || seen.has(url)) continue;
    seen.add(url); out.push({ url, alt: typeof item.variant === "string" ? item.variant.slice(0, 4000) : "" });
  }
  return out;
}
/** Twister data: `"parentAsin": "B0..."` and `"dimensionValuesDisplayData": {ASIN: [labels]}`. */
export function amazonStaticTwister(html: string): { parentAsin: string | null; siblings: { asin: string; label: string }[] } {
  const parent = html.match(/"parentAsin"\s*:\s*"([A-Z0-9]{10})"/)?.[1] ?? null;
  const dims = html.match(/"dimensionValuesDisplayData"\s*:\s*(\{[^{}]*\})/)?.[1];
  const siblings: { asin: string; label: string }[] = [];
  if (dims) {
    try {
      for (const [asin, labels] of Object.entries(JSON.parse(dims) as Record<string, unknown>))
        if (ASIN.test(asin) && Array.isArray(labels)) siblings.push({ asin, label: labels.filter(l => typeof l === "string").join(" / ").slice(0, 1000) });
    } catch { /* malformed twister data is not evidence */ }
  }
  return { parentAsin: parent, siblings };
}

/** Parse a static product page into the same projection the browser reader produces, by running the shared
 * DOM expression in a linkedom document. Scripts/styles are removed first so innerText is what a user sees. */
export function parseAmazonStaticHtml(html: string, pageUrl: string, fetchedVia?: FetchedVia): AmazonRenderedProduct {
  if (CHALLENGE.test(html)) throw new ChannelError("AMAZON.ACCESS_CHALLENGE");
  const address = amazonProductAddress(pageUrl), gallery = amazonStaticGallery(html), twister = amazonStaticTwister(html);
  const { document, HTMLElement, HTMLAnchorElement } = parseHTML(html);
  for (const e of [...document.querySelectorAll("script,style,noscript,template")]) e.remove();
  // Static HTML has no layout: only explicit hidden markers exclude an element. Anchors resolve against the page.
  Object.defineProperty(HTMLElement.prototype, "getClientRects", { configurable: true,
    value: function (this: Element) { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}]; } });
  Object.defineProperty(HTMLAnchorElement.prototype, "href", { configurable: true,
    get(this: Element) { const v = this.getAttribute("href"); if (v == null) return ""; try { return new URL(v, pageUrl).href; } catch { return v; } } });
  const raw = runInNewContext(amazonProductExpression, { document, URL, location: { origin: address.url.slice(0, address.url.indexOf("/dp/")), href: pageUrl },
    getComputedStyle: () => ({ visibility: "visible" }) }, { timeout: 10000 }) as Record<string, any>;
  if (raw.asin !== address.asin) throw new ChannelError("AMAZON.ASIN_CONFLICT");
  const normalize = (s: unknown) => typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  // Seller: static pages name the merchant in the offer-display widget instead of the seller profile link.
  const conditions = raw.commerce?.purchaseConditions;
  if (conditions && conditions.seller?.name == null) {
    const names = [...new Set([...document.querySelectorAll('[data-csa-c-slot-id="odf-desktop-merchant-info-anchor-text"]')].map(e => normalize(e.textContent)).filter(Boolean))];
    if (names.length === 1) {
      conditions.seller.name = names[0]!.slice(0, 4000);
      conditions.warnings = (conditions.warnings as string[]).filter(w => w !== "PURCHASE.SELLER_UNKNOWN");
      conditions.evidence.push({ field: "seller", selector: '[data-csa-c-slot-id="odf-desktop-merchant-info-anchor-text"]', text: names[0] });
    }
  }
  const self = address.asin, origin = address.url.slice(0, address.url.indexOf("/dp/"));
  const variants = new Map<string, { asin: string; url: string; label: string }>();
  for (const v of raw.variants ?? []) if (v?.asin && v.asin !== self) variants.set(v.asin, v);
  for (const s of twister.siblings) if (s.asin !== self && !variants.has(s.asin)) variants.set(s.asin, { asin: s.asin, url: `${origin}/dp/${s.asin}`, label: s.label });
  const projection = { ...raw, deliveryText: normalize(raw.deliveryText).slice(0, 1000),
    galleryCount: gallery.length, gallery: gallery.map((g, index) => ({ index, ...g })),
    variantControls: Math.max(Number(raw.variantControls) || 0, twister.siblings.length ? 1 : 0), variants: [...variants.values()].slice(0, 100),
    ...(twister.parentAsin ? { parentAsin: twister.parentAsin } : {}), ...(fetchedVia ? { fetchedVia } : {}) };
  if (!gallery.length) throw new ChannelError("AMAZON.GALLERY_UNVERIFIED");
  return AmazonRenderedProductSchema.parse(projection);
}

const decodeHtml = (bytes: Uint8Array) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ChannelError('AMAZON.ENCODING'); }
};
/** Explicit one-shot transport primitive. Product capture must use the archive-gated reader below. */
export async function readAmazonHtml(route: HttpRoute, rawUrl: string, abort: AbortSignal, dns: DnsResolver = systemDns): Promise<string> {
  return decodeHtml(await readAmazonHtmlBytes(route, rawUrl, abort, dns));
}
/** One bounded GET of a public Amazon page through the configured route (ScraperAPI).
 * Errors terminate this download; neither this reader nor its product adapter retries. */
async function readAmazonHtmlBytes(route: HttpRoute, rawUrl: string, abort: AbortSignal, dns: DnsResolver, admissionDeadline?: number): Promise<Uint8Array> {
  requireCapability(route, "http");
  const url = permittedUrl(rawUrl, AMAZON_HTTP_POLICY.origins);
  const controller = new AbortController(), signal = AbortSignal.any([abort, controller.signal]);
  const timer = setTimeout(() => controller.abort(new NetworkError("NETWORK.TIMEOUT")), AMAZON_HTTP_POLICY.timeoutMs);
  let response: Response | undefined;
  try {
    const address = await abortable(transportAddress(url, route.transport, dns, signal), signal);
    signal.throwIfAborted();
    if (admissionDeadline !== undefined && Date.now() > admissionDeadline) throw new ChannelError('AMAZON.HTML_ADMISSION_EXPIRED');
    const got = await abortable(route.transport.get(url, address, { accept: "text/html" }, signal).then(r => { if (signal.aborted) { r.close(); signal.throwIfAborted(); } return r; }), signal);
    response = got; signal.throwIfAborted();
    if (got.status >= 300 && got.status < 400) throw new ChannelError("AMAZON.REDIRECT_UNVERIFIED");
    if ([403, 406, 429, 503].includes(got.status)) throw new ChannelError("AMAZON.ACCESS_CHALLENGE");
    if ([404, 410].includes(got.status)) throw new ChannelError("AMAZON.NOT_FOUND");
    if (got.status !== 200) throw new ChannelError("AMAZON.HTTP_STATUS");
    if (!/^text\/html(?:\s*;|$)/i.test(got.headers["content-type"] ?? "")) throw new ChannelError("AMAZON.NOT_HTML");
    const encoding = got.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding && encoding !== "identity") throw new ChannelError("AMAZON.ENCODING");
    const declared = got.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > AMAZON_HTTP_POLICY.maxBytes)) throw new ChannelError("AMAZON.PAGE_LIMIT");
    const chunks: Uint8Array[] = []; let size = 0;
    const iterator = got.body[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted();
      const next = await abortable(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      size += next.value.byteLength; if (size > AMAZON_HTTP_POLICY.maxBytes) throw new ChannelError("AMAZON.PAGE_LIMIT");
      chunks.push(next.value);
    }
    if (!size) throw new ChannelError("AMAZON.PAGE_EMPTY");
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); response?.close(); }
}

/** HTTP capture adapter: same `AmazonRenderedProduct` projection as `AmazonEgoReader.product`, from static HTML.
 * Delivery context cannot be set on a proxied request, so a postal-code requirement is rejected, not ignored. */
export class AmazonHttpReader {
  readonly fetchedVia: FetchedVia;
  constructor(private readonly route: HttpRoute, private readonly dns: DnsResolver = systemDns, private readonly fetchGate?: AmazonHtmlFetchGate) {
    requireCapability(route, "http");
    const s = route.selection;
    this.fetchedVia = Object.freeze({ mode: "http", routeId: s.routeId, egressId: s.egressId, provider: s.mode === "scraperapi" ? s.providerPolicy : s.mode });
  }
  private projection(url: string, saved: ArchivedAmazonHtml): AmazonRenderedProduct {
    const p = parseAmazonStaticHtml(decodeHtml(saved.bytes), url, saved.fetchedVia ?? this.fetchedVia);
    return AmazonRenderedProductSchema.parse({ ...p, capturedAt: saved.capturedAt, originalHtml: saved.source });
  }
  /** Offline continuation: never invokes the transport, including when the archive is missing. */
  async archivedProduct(url: string, signal: AbortSignal, archive: AmazonHtmlArchive): Promise<AmazonRenderedProduct | null> {
    if (archive.job.discovery.entry.url !== url) throw new ChannelError('AMAZON.HTML_ARCHIVE_IDENTITY');
    const saved = await archive.inspect(signal);
    return saved ? this.projection(url, saved) : null;
  }
  async product(url: string, signal: AbortSignal, retain?: (raw: unknown) => Promise<void>, postalCode?: string, archive?: AmazonHtmlArchive): Promise<AmazonRenderedProduct> {
    if (postalCode !== undefined) throw new ChannelError("AMAZON.DELIVERY_POLICY_UNSUPPORTED");
    if (!archive) throw new ChannelError('AMAZON.HTML_ARCHIVE_REQUIRED');
    if (archive.job.discovery.entry.url !== url) throw new ChannelError('AMAZON.HTML_ARCHIVE_IDENTITY');
    const address = amazonProductAddress(url);
    let saved = await archive.inspect(signal);
    if (!saved) {
      if (!this.fetchGate) throw new ChannelError('AMAZON.HTML_FETCH_GATE_REQUIRED');
      await archive.beginDownload(signal);
      const admissionDeadline = Date.now() + 5000;
      const admission = await this.fetchGate.acquire(archive.job, signal);
      if (admission.kind === 'reuse') {
        saved = await archive.reuse(new AmazonHtmlArchive(archive.publication, admission.job), signal);
        // Reconcile an R2 success whose database acknowledgment was lost. No provider retry.
        await this.fetchGate.complete(admission.job, saved.capturedAt, signal);
      } else {
        saved = await archive.save(await readAmazonHtmlBytes(this.route, url, signal, this.dns, admissionDeadline), signal, { fetchedVia: this.fetchedVia });
        await this.fetchGate.complete(archive.job, saved.capturedAt, signal);
      }
    }
    const p = this.projection(url, saved);
    if (p.asin !== address.asin) throw new ChannelError("AMAZON.ASIN_CONFLICT");
    await retain?.(p);
    parseAmazonRenderedProduct(p, url, { listingId: address.asin, variantId: null });
    return p;
  }
}
