import type { ChannelAdapter, ParsedProduct } from "../adapter.js";
import { channelErrors } from "../errors.js";
import {
  movedSighting,
  notFoundSighting,
  type ListingSighting,
} from "../pipeline/listing-sighting.js";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";
import type { PageFetcher } from "./page-fetch.js";
import { decodeHtml } from "./read-html.js";

export interface CapturedProduct {
  parsed: ParsedProduct;
  /** Where the original page is archived, for the formula planner and for later reanalysis. */
  archiveKey: string;
  archiveSha256: string;
  capturedAt: string;
}

/** A readable product page, or what the revisit showed instead: the listing is unlisted, and why. */
export type HttpCaptureResult =
  ({ status: "page" } & CapturedProduct) | { status: "sighting"; sighting: ListingSighting };

type Download = { page: ArchivedHtml } | { sighting: ListingSighting };

/**
 * Product-page capture for any channel, through its page fetcher (ScraperAPI; the browser only for the channels
 * that declare it): read the archive first; only when nothing is archived,
 * record the intent, download once, archive, read back, then let the channel adapter parse the archived bytes.
 * A page that no longer exists (404/410) or was redirected to another product or away from any product is reported
 * as an unlisted sighting, not parsed.
 */
export class HttpCapture {
  constructor(private readonly pages: PageFetcher) {}

  async capture(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    signal: AbortSignal,
  ): Promise<HttpCaptureResult> {
    if (!adapter.captureModes.includes(this.pages.mode)) {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED", {
        details: { channel: adapter.id, mode: this.pages.mode },
      });
    }
    const archived = await archive.inspect(signal);
    const download = archived ? { page: archived } : await this.download(adapter, archive, signal);
    if ("sighting" in download) {
      return { status: "sighting", sighting: download.sighting };
    }
    const saved = download.page;
    const moved = this.moved(adapter, archive, saved);
    if (moved) {
      return { status: "sighting", sighting: moved };
    }
    const url = archive.capture.url;
    const parsed = adapter.parseProduct({
      url,
      html: decodeHtml(saved.bytes),
      capturedAt: saved.capturedAt,
    });
    return {
      status: "page",
      parsed,
      archiveKey: saved.source.objectKey,
      archiveSha256: saved.source.sha256,
      capturedAt: saved.capturedAt,
    };
  }

  /** Records the intent, downloads once and archives; a page that no longer exists is a `not_found` sighting. */
  private async download(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    signal: AbortSignal,
  ): Promise<Download> {
    await archive.beginDownload(signal);
    const request = { channel: adapter.id, url: archive.capture.url, policy: adapter.httpPolicy };
    let page;
    try {
      page = await this.pages.fetchPage(request, signal);
    } catch (error) {
      const unlisted = notFoundSighting(error);
      if (unlisted) {
        return { sighting: unlisted };
      }
      throw error;
    }
    return { page: await archive.save(page.bytes, page.fetchedVia, signal) };
  }

  /** A page a same-site redirect moved to another listing, or to no product at all. */
  private moved(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    saved: ArchivedHtml,
  ): ListingSighting | null {
    if (!saved.finalUrl) {
      return null;
    }
    const { url, listingId, variantId } = archive.capture;
    const requested = { url, listingId, variantId };
    const moved = { finalUrl: saved.finalUrl, archiveKey: saved.source.objectKey };
    return movedSighting(adapter, requested, moved);
  }
}
