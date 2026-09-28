import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { SwansonRenderedProductSchema, type SwansonRenderedProduct } from "@crawl-automation/v3-contracts";
import { abortable, transportAddress, permittedUrl, systemDns, requireCapability, NetworkError,
  type DnsResolver, type HttpRoute, type Response } from "@crawl-automation/v3-acquisition";
import { swansonProductExpression } from "./swanson-ego.js";
import { swansonProductAddress } from "./swanson-rendered.js";
import { ChannelError } from "./html-evidence.js";
import { SwansonHtmlArchive } from "./swanson-html-archive.js";

/** Bounded raw HTML read of one public Swanson product page (ScraperAPI route). No JS, cookies, redirects or retries. */
export const SWANSON_HTTP_POLICY = Object.freeze({ timeoutMs: 75000, maxBytes: 6 * 1024 * 1024, origins: Object.freeze(["https://www.swansonvitamins.com"]) });
// Cloudflare's challenge page, not its precursor script that every normal page also loads (/cdn-cgi/challenge-platform/).
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required)|id="challenge-form"|cf-chl-bypass/i;

/** Static product page -> the same projection the Ego reader produces: the shared DOM expression runs in a linkedom
 * document (checked on 2026-09-28: h1, canonical /p/<handle>, one product form and variant input, gallery, size radios
 * and the Product Facts section are all server-rendered). Scripts are removed so innerText is what a visitor reads. */
export function parseSwansonStaticHtml(html: string, pageUrl: string, capturedAt: string): SwansonRenderedProduct {
  if (CHALLENGE.test(html)) throw new ChannelError("SWANSON.ACCESS_CHALLENGE");
  swansonProductAddress(pageUrl);
  const { document, HTMLElement, HTMLImageElement, HTMLAnchorElement, HTMLLinkElement, HTMLInputElement, HTMLMetaElement } = parseHTML(html);
  for (const e of [...document.querySelectorAll("script,style,noscript,template")]) e.remove();
  const absolute = (v: string | null) => { if (v == null) return ""; try { return new URL(v, pageUrl).href; } catch { return v; } };
  const define = (proto: object, name: string, get: (this: Element) => unknown) => Object.defineProperty(proto, name, { configurable: true, get });
  // Static HTML has no layout: only explicit hidden markers exclude an element. URLs resolve against the page.
  Object.defineProperty(HTMLElement.prototype, "getClientRects", { configurable: true,
    value: function (this: Element) { return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}]; } });
  define(HTMLImageElement.prototype, "src", function () { return absolute(this.getAttribute("src")); });
  define(HTMLImageElement.prototype, "currentSrc", function () { return absolute(this.getAttribute("src")); });
  define(HTMLImageElement.prototype, "alt", function () { return this.getAttribute("alt") ?? ""; });
  define(HTMLAnchorElement.prototype, "href", function () { return absolute(this.getAttribute("href")); });
  define(HTMLLinkElement.prototype, "href", function () { return absolute(this.getAttribute("href")); });
  define(HTMLMetaElement.prototype, "content", function () { return this.getAttribute("content") ?? ""; });
  define(HTMLInputElement.prototype, "checked", function () { return this.hasAttribute("checked"); });
  define(HTMLInputElement.prototype, "value", function () { return this.getAttribute("value") ?? ""; });
  let raw: Record<string, unknown>;
  try {
    raw = runInNewContext(swansonProductExpression, { document, URL, location: { href: pageUrl, origin: "https://www.swansonvitamins.com" },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }) }, { timeout: 10000 }) as Record<string, unknown>;
  } catch (e) { throw new ChannelError(/SWANSON_PRODUCT_TEMPLATE/.test(String((e as Error)?.message)) ? "SWANSON.PRODUCT_TEMPLATE" : "SWANSON.STATIC_PARSE_FAILED"); }
  return SwansonRenderedProductSchema.parse({ ...raw, url: pageUrl, capturedAt });
}

const decodeHtml = (bytes: Uint8Array) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ChannelError("SWANSON.ENCODING"); }
};
/** One bounded GET of a public Swanson page through the configured route (ScraperAPI). Errors end this download;
 * neither this reader nor its product adapter retries. */
async function readSwansonHtmlBytes(route: HttpRoute, rawUrl: string, abort: AbortSignal, dns: DnsResolver): Promise<Uint8Array> {
  requireCapability(route, "http");
  const url = permittedUrl(rawUrl, SWANSON_HTTP_POLICY.origins);
  const controller = new AbortController(), signal = AbortSignal.any([abort, controller.signal]);
  const timer = setTimeout(() => controller.abort(new NetworkError("NETWORK.TIMEOUT")), SWANSON_HTTP_POLICY.timeoutMs);
  let response: Response | undefined;
  try {
    const address = await abortable(transportAddress(url, route.transport, dns, signal), signal);
    signal.throwIfAborted();
    const got = await abortable(route.transport.get(url, address, { accept: "text/html" }, signal).then(r => { if (signal.aborted) { r.close(); signal.throwIfAborted(); } return r; }), signal);
    response = got; signal.throwIfAborted();
    if (got.status >= 300 && got.status < 400) throw new ChannelError("SWANSON.REDIRECT_UNVERIFIED", { status: got.status });
    if ([403, 406, 429, 503].includes(got.status)) throw new ChannelError("SWANSON.ACCESS_CHALLENGE");
    if ([404, 410].includes(got.status)) throw new ChannelError("SWANSON.NOT_FOUND");
    if (got.status !== 200) throw new ChannelError("SWANSON.HTTP_STATUS");
    if (!/^text\/html(?:\s*;|$)/i.test(got.headers["content-type"] ?? "")) throw new ChannelError("SWANSON.NOT_HTML");
    const encoding = got.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding && encoding !== "identity") throw new ChannelError("SWANSON.ENCODING");
    const chunks: Uint8Array[] = []; let size = 0;
    const iterator = got.body[Symbol.asyncIterator]();
    for (;;) {
      signal.throwIfAborted();
      const next = await abortable(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      size += next.value.byteLength; if (size > SWANSON_HTTP_POLICY.maxBytes) throw new ChannelError("SWANSON.PAGE_LIMIT");
      chunks.push(next.value);
    }
    if (!size) throw new ChannelError("SWANSON.PAGE_NOT_DELIVERED", { kind: "empty-body", status: got.status });
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); response?.close(); }
}

/** HTTP capture adapter with the same product projection as SwansonEgoReader.product, from archived static HTML. */
export class SwansonHttpReader {
  readonly fetchedVia: { mode: "http"; routeId: string; egressId: string; provider: string };
  constructor(private readonly route: HttpRoute, private readonly dns: DnsResolver = systemDns) {
    requireCapability(route, "http");
    const s = route.selection;
    this.fetchedVia = Object.freeze({ mode: "http" as const, routeId: s.routeId, egressId: s.egressId, provider: s.mode === "scraperapi" ? s.providerPolicy : s.mode });
  }
  /** Reads the archive first; downloads once only when nothing is archived for this operation. */
  async product(url: string, signal: AbortSignal, archive: SwansonHtmlArchive): Promise<SwansonRenderedProduct> {
    if (archive.capture.url !== url) throw new ChannelError("SWANSON.HTML_ARCHIVE_IDENTITY");
    let saved = await archive.inspect(signal);
    if (!saved) {
      await archive.beginDownload(signal);
      saved = await archive.save(await readSwansonHtmlBytes(this.route, url, signal, this.dns), signal, this.fetchedVia);
    }
    const p = parseSwansonStaticHtml(decodeHtml(saved.bytes), url, saved.capturedAt);
    if (p.url !== url) throw new ChannelError("CHANNEL.IDENTITY_CONFLICT");
    return p;
  }
}
