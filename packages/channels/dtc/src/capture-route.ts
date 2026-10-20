import {
  BrowserProductCapture,
  HttpCapture,
  channelErrors,
  decodeHtml,
  samePage,
  type BrowserCaptureResult,
  type CaptureRequest,
  type ChannelRegistry,
  type FetchedHtml,
  type PageFetcher,
  type ProductSourcePlans,
} from "@crawl-automation/channels-core";
import { errorCodeOf, type RetainedPublication } from "@crawl-automation/platform";
import { createDtcAdapter } from "./adapter.js";
import { siteForUrl } from "./address.js";
import { readDtcProduct } from "./product.js";
import type { DtcSitePolicy } from "./site-policy.js";

/** Why one product went to the platform reader or to the agent; logged with every DTC capture. */
export type DtcCaptureDecision =
  { route: "platform"; site: string } | { route: "agent"; site: string; reason: string };

/**
 * Reader verdicts that mean "this page's data is not in the platform's shape": the agent may still read it.
 * A bot challenge, an oversized page or a rejected address is the same for both and stays a Review.
 */
const PLATFORM_READ_FAILURES: ReadonlySet<string> = new Set([
  "DTC.PLATFORM_UNVERIFIED",
  "DTC.PRODUCT_MISSING",
  "DTC.IDENTITY_UNVERIFIED",
  "DTC.JSON_INVALID",
]);

/**
 * Owner 2026-10-20: DTC product capture by site. A `platform` site is read once in Ego (the page is kept) and, when
 * the platform reader recognises a single-variant product, that same page enters the shared archive-first capture
 * exactly as Swanson's pages do. Multi-variant products and pages the reader does not recognise go to the Codex
 * capture agent as before (one variant per URL is step 2). No page is read twice and nothing is archived before the
 * route is known.
 */
export class DtcPlatformCapture {
  constructor(
    private readonly deps: {
      /** The browser page fetcher (Ego); the shared capture's fetcher for the DTC channel. */
      pages: PageFetcher;
      registry: ChannelRegistry;
      publication: RetainedPublication;
      sourcePlans: ProductSourcePlans;
      /** The Codex capture agent, for `agent` sites and for pages the platform reader does not recognise. */
      agent: Pick<BrowserProductCapture, "capture">;
      /** The current site policies; the worker refreshes this array in place. */
      sites: readonly DtcSitePolicy[];
      onDecision?: (decision: DtcCaptureDecision & { url: string; operationId: string }) => void;
    },
  ) {}

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<BrowserCaptureResult> {
    const site = siteForUrl(request.url, this.deps.sites);
    if (site.capture !== "platform") {
      return this.decided(
        { request, decision: { route: "agent", site: site.siteKey, reason: "site_policy" } },
        signal,
      );
    }
    const adapter = createDtcAdapter(this.deps.sites, request.sourceUrl);
    const address = adapter.productAddress(request.url);
    const fetched = await this.deps.pages.fetchPage(
      { channel: "dtc", url: address.url, policy: adapter.httpPolicy },
      signal,
    );
    const decision = platformDecision(fetched, { url: address.url, site, sites: this.deps.sites });
    return this.decided({ request, decision, fetched }, signal);
  }

  private decided(
    at: { request: CaptureRequest; decision: DtcCaptureDecision; fetched?: FetchedHtml },
    signal: AbortSignal,
  ): Promise<BrowserCaptureResult> {
    const { request, decision, fetched } = at;
    this.deps.onDecision?.({ ...decision, url: request.url, operationId: request.operationId });
    if (decision.route === "agent" || !fetched) {
      return this.deps.agent.capture(request, signal);
    }
    const { registry, publication, sourcePlans } = this.deps;
    const http = new HttpCapture(replayFetcher(fetched, request.url));
    return new BrowserProductCapture({ registry, http, publication, sourcePlans }).capture(
      request,
      signal,
    );
  }
}

/** The platform reader's verdict on the page just read; the shared capture judges a moved page itself. */
function platformDecision(
  fetched: FetchedHtml,
  at: { url: string; site: DtcSitePolicy; sites: readonly DtcSitePolicy[] },
): DtcCaptureDecision {
  const site = at.site.siteKey;
  const finalUrl = fetched.fetchedVia.finalUrl;
  if (finalUrl && !samePage(finalUrl, at.url)) {
    return { route: "platform", site };
  }
  try {
    const product = readDtcProduct(
      {
        url: finalUrl ?? at.url,
        html: decodeHtml(fetched.bytes),
        capturedAt: new Date().toISOString(),
      },
      at.sites,
    );
    return product.variants.length > 1
      ? { route: "agent", site, reason: "multi_variant" }
      : { route: "platform", site };
  } catch (error) {
    const code = errorCodeOf(error);
    if (code && PLATFORM_READ_FAILURES.has(code)) {
      return { route: "agent", site, reason: code };
    }
    throw error;
  }
}

/** Hands the page already read to the shared capture, once, for exactly that address. */
function replayFetcher(fetched: FetchedHtml, requested: string): PageFetcher {
  let served = false;
  return {
    mode: "browser",
    fetchPage: async (request) => {
      if (served || !samePage(request.url, requested)) {
        throw channelErrors.create("CAPTURE.DOWNLOAD_UNRESOLVED", {
          details: {
            reason: served ? "page_already_served" : "address_mismatch",
            url: request.url,
          },
        });
      }
      served = true;
      return fetched;
    },
  };
}
