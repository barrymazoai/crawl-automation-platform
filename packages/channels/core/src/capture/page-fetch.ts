import {
  allowedTarget,
  type ScraperApiClient,
  type ScraperApiOptions,
} from "@crawl-automation/platform";
import type { ChannelId, HttpPolicy } from "../adapter.js";
import type { CaptureMode } from "../capture.js";
import { channelErrors } from "../errors.js";
import type { FetchedVia } from "./original-html-archive.js";
import { checkPage } from "./read-html.js";
import { channelOptions, type ChannelOptions } from "./channel-options.js";
export type { ChannelOptions } from "./channel-options.js";

/** One product page to fetch, within its channel's limits. */
export interface PageRequest {
  channel: ChannelId;
  url: string;
  policy: HttpPolicy;
}

/** A fetched page, not yet archived, and how it was fetched. */
export interface FetchedHtml {
  bytes: Uint8Array;
  fetchedVia: FetchedVia;
}

/** Fetches one product page, in one capture mode; a channel is captured only by a fetcher of a mode it declares. */
export interface PageFetcher {
  readonly mode: CaptureMode;
  fetchPage(request: PageRequest, signal: AbortSignal): Promise<FetchedHtml>;
}

/** Where ScraperAPI fetches run, and each channel's options over the shared defaults. */
export interface ScraperApiCaptureSettings {
  routeId: string;
  egressId: string;
  defaults: ScraperApiOptions;
  /** A channel's own options, e.g. premium proxies for a site that blocks plain requests. */
  channels: Partial<Record<ChannelId, ChannelOptions>>;
}

/** Product pages through ScraperAPI, with the options the channel's settings choose. */
export class ScraperApiPages implements PageFetcher {
  readonly mode = "http";

  constructor(
    private readonly client: Pick<ScraperApiClient, "get" | "provider">,
    private readonly settings: ScraperApiCaptureSettings,
  ) {}

  async fetchPage(request: PageRequest, abort: AbortSignal): Promise<FetchedHtml> {
    const { policy } = request;
    const target = allowedTarget(withoutFragment(request.url), policy.origins).href;
    const options = channelOptions(this.settings.defaults, this.settings.channels[request.channel]);
    const signal = AbortSignal.any([abort, AbortSignal.timeout(policy.timeoutMs)]);
    const tooLarge = () =>
      channelErrors.create("CAPTURE.PAGE_LIMIT", { details: { maxBytes: policy.maxBytes } });
    const page = await this.client.get(
      { target, options, maxBytes: policy.maxBytes, tooLarge },
      signal,
    );
    checkPage(page);
    const { routeId, egressId } = this.settings;
    const provider = this.client.provider;
    const { headers: _headers, ...publicOptions } = options;
    const fetchedVia = {
      mode: "http" as const,
      routeId,
      egressId,
      provider,
      options: publicOptions,
    };
    const moved = page.url === target ? {} : { finalUrl: page.url };
    return {
      bytes: page.bytes,
      fetchedVia: { ...fetchedVia, creditCost: page.creditCost, ...moved },
    };
  }
}

/** A fragment never reaches the website; channels may use one to name a variant on a shared page (Costco). */
function withoutFragment(raw: string): string {
  const url = URL.parse(raw);
  if (!url) {
    return raw;
  }
  url.hash = "";
  return url.href;
}
