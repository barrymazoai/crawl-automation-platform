import { allowedTarget, type BrowserPage, type BrowserRead } from "@crawl-automation/platform";
import type { ChannelId } from "../adapter.js";
import { channelErrors } from "../errors.js";
import type { FetchedHtml, PageFetcher, PageRequest } from "./page-fetch.js";
import { checkPage } from "./read-html.js";

/** How the browser reads one channel's product pages, and the store it has chosen for a store-priced channel. */
export interface BrowserChannelPolicy {
  /** The element that shows a product page has been drawn, e.g. `h1`. */
  readySelector: string;
  /** Recorded with every page of a channel priced by store (Whole Foods). */
  storeId?: string;
}

/** Where browser reads run, and the only channels allowed to use them. */
export interface BrowserCaptureSettings {
  routeId: string;
  egressId: string;
  channels: Partial<Record<ChannelId, BrowserChannelPolicy>>;
}

/** The browser as this fetcher needs it: one page read in a task page that is closed before it returns. */
export interface BrowserReader {
  readonly provider: string;
  read(request: BrowserRead, signal: AbortSignal): Promise<BrowserPage>;
}

/**
 * Product pages drawn in the browser, for the owner-approved browser channels only (Whole Foods). Everything after
 * the fetch is the shared capture: the archive is read first, the page is archived before it is parsed.
 */
export class BrowserPages implements PageFetcher {
  readonly mode = "browser";

  constructor(
    private readonly browser: BrowserReader,
    private readonly settings: BrowserCaptureSettings,
  ) {}

  async fetchPage(request: PageRequest, abort: AbortSignal): Promise<FetchedHtml> {
    const own = this.settings.channels[request.channel];
    if (!own) {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED", {
        details: { channel: request.channel, mode: this.mode },
      });
    }
    const { policy } = request;
    const target = allowedTarget(request.url, policy.origins).href;
    const signal = AbortSignal.any([abort, AbortSignal.timeout(policy.timeoutMs)]);
    const read = { url: target, readySelector: own.readySelector, timeoutMs: policy.timeoutMs };
    const page = await this.browser.read(read, signal);
    const bytes = Buffer.from(page.html);
    if (bytes.byteLength > policy.maxBytes) {
      throw channelErrors.create("CAPTURE.PAGE_LIMIT", { details: { maxBytes: policy.maxBytes } });
    }
    // A drawn page without navigation timing has no status to judge; the adapter then decides if it is a product.
    checkPage({
      status: page.status ?? 200,
      contentType: "text/html",
      contentEncoding: null,
      bytes,
    });
    return { bytes, fetchedVia: this.fetchedVia(page, { target, storeId: own.storeId }) };
  }

  private fetchedVia(page: BrowserPage, read: { target: string; storeId: string | undefined }) {
    const { routeId, egressId } = this.settings;
    const store = read.storeId === undefined ? {} : { storeId: read.storeId };
    const moved = page.url === read.target ? {} : { finalUrl: page.url };
    const provider = this.browser.provider;
    return { mode: "browser" as const, routeId, egressId, provider, ...store, ...moved };
  }
}
