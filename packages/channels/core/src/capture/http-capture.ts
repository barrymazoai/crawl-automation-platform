import {
  requireCapability,
  systemDns,
  type DnsResolver,
  type HttpRoute,
} from "@crawl-automation/v3-acquisition";
import type { ChannelAdapter, ParsedProduct } from "../adapter.js";
import { channelErrors } from "../errors.js";
import type { FetchedVia, OriginalHtmlArchive } from "./original-html-archive.js";
import { decodeHtml, readHtmlBytes } from "./read-html.js";

export interface CapturedProduct {
  parsed: ParsedProduct;
  /** Where the original page is archived, for the formula planner and for later reanalysis. */
  archiveKey: string;
  capturedAt: string;
}

/**
 * HTTP capture (ScraperAPI) for any channel: read the archive first; only when nothing is archived, record the
 * intent, download once, archive, read back, then let the channel adapter parse the archived bytes.
 */
export class HttpCapture {
  readonly fetchedVia: FetchedVia;

  constructor(
    private readonly route: HttpRoute,
    private readonly dns: DnsResolver = systemDns,
  ) {
    requireCapability(route, "http");
    const selection = route.selection;
    const provider = selection.mode === "scraperapi" ? selection.providerPolicy : selection.mode;
    this.fetchedVia = {
      mode: "http",
      routeId: selection.routeId,
      egressId: selection.egressId,
      provider,
    };
  }

  async capture(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    signal: AbortSignal,
  ): Promise<CapturedProduct> {
    const policy = adapter.httpPolicy;
    if (!adapter.captureModes.includes("http") || !policy) {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED", {
        details: { channel: adapter.id, mode: "http" },
      });
    }
    const url = archive.capture.url;
    let saved = await archive.inspect(signal);
    if (!saved) {
      await archive.beginDownload(signal);
      const bytes = await readHtmlBytes({ route: this.route, url, policy, dns: this.dns }, signal);
      saved = await archive.save(bytes, this.fetchedVia, signal);
    }
    const parsed = adapter.parseProduct({
      url,
      html: decodeHtml(saved.bytes),
      capturedAt: saved.capturedAt,
    });
    return { parsed, archiveKey: saved.source.objectKey, capturedAt: saved.capturedAt };
  }
}
