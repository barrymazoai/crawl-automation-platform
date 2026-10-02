import { errorCodeOf } from "@crawl-automation/platform";
import type { ChannelAdapter, FetchedPage, ParsedProduct } from "../adapter.js";
import { channelErrors } from "../errors.js";
import {
  movedSighting,
  identitySighting,
  notFoundSighting,
  type ListingSighting,
} from "../pipeline/listing-sighting.js";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";
import type { PageFetcher } from "./page-fetch.js";
import { decodeHtml } from "./read-html.js";
import { htmlCaptureErrors, type HtmlCaptureRecords } from "./html-capture-records.js";
import type { HtmlCaptureRequest } from "./html-capture-model.js";
import { recoverOriginal } from "./recover-original.js";

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
  constructor(
    private readonly pages: PageFetcher,
    private readonly records?: HtmlCaptureRecords,
  ) {}

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
    const request = { channel: adapter.id, capture: archive.capture };
    if (archived) {
      await this.records?.complete(request, archive.reference(archived));
    }
    const download = archived ? { page: archived } : await this.acquire(adapter, archive, signal);
    if ("sighting" in download) {
      return { status: "sighting", sighting: download.sighting };
    }
    const saved = download.page;
    const moved = this.moved(adapter, archive, saved);
    if (moved) {
      return { status: "sighting", sighting: moved };
    }
    return this.readProduct(adapter, archive, saved);
  }

  /** Page-owned identity is checked before facts, images or formula planning can turn a wrong page into a Review. */
  private readProduct(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    saved: ArchivedHtml,
  ): HttpCaptureResult {
    const page: FetchedPage = {
      url: saved.url,
      html: decodeHtml(saved.bytes),
      capturedAt: saved.capturedAt,
    };
    const observed = adapter.pageIdentity?.(page);
    const conflict =
      observed && identitySighting(archive.capture, observed, saved.source.objectKey);
    if (conflict) {
      return { status: "sighting", sighting: conflict };
    }
    const sighting = adapter.pageSighting?.(page);
    if (sighting) {
      return { status: "sighting", sighting: { ...sighting, archiveKey: saved.source.objectKey } };
    }
    const parsed = adapter.parseProduct(page);
    // An explicit null is authoritative: the adapter has no verified page identity (Whole Foods, R22).
    const parsedConflict =
      !adapter.pageIdentity &&
      identitySighting(archive.capture, parsed.identity, saved.source.objectKey);
    if (parsedConflict) {
      return { status: "sighting", sighting: parsedConflict };
    }
    return {
      status: "page",
      parsed,
      archiveKey: saved.source.objectKey,
      archiveSha256: saved.source.sha256,
      capturedAt: saved.capturedAt,
    };
  }

  /** Atomic recent-original lookup and reservation, before any paid request or parsing. */
  private async acquire(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    signal: AbortSignal,
  ): Promise<Download> {
    if (!this.records) {
      return this.reserved({ adapter, archive, previous: [] }, signal);
    }
    const request = { channel: adapter.id, capture: archive.capture };
    const decision = await this.records.admit(request);
    if (decision.status === "reuse") {
      return { page: await archive.reuse(decision.original, signal) };
    }
    if (decision.status === "in_flight") {
      throw htmlCaptureErrors.create("CAPTURE.IN_FLIGHT", {
        details: { operationId: decision.operationId },
      });
    }
    if (decision.status === "unresolved") {
      throw channelErrors.create("CAPTURE.DOWNLOAD_UNRESOLVED");
    }
    return this.reserved({ adapter, archive, previous: decision.previous ?? [] }, signal);
  }

  /** Every failure after admission ends this reservation, including intent and publication failures. */
  private async reserved(
    target: {
      adapter: ChannelAdapter;
      archive: OriginalHtmlArchive;
      previous: HtmlCaptureRequest[];
    },
    signal: AbortSignal,
  ): Promise<Download> {
    const { adapter, archive, previous } = target;
    const request = { channel: adapter.id, capture: archive.capture };
    try {
      const recovered = await recoverOriginal({ archive, records: this.records }, previous, signal);
      if (recovered) {
        const page = await archive.reuse(recovered, signal);
        await this.records?.complete(request, recovered);
        return { page };
      }
      return await this.download(adapter, archive, signal);
    } catch (error) {
      await this.records?.fail(request, errorCodeOf(error));
      const unlisted = notFoundSighting(error);
      if (unlisted) {
        return { sighting: unlisted };
      }
      throw error;
    }
  }

  /** Records the intent, downloads once and archives; a page that no longer exists is a `not_found` sighting. */
  private async download(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    signal: AbortSignal,
  ): Promise<Download> {
    await archive.beginDownload(signal);
    const request = { channel: adapter.id, url: archive.capture.url, policy: adapter.httpPolicy };
    const page = await this.pages.fetchPage(request, signal);
    const saved = await archive.save(page.bytes, page.fetchedVia, signal);
    await this.records?.complete(
      { channel: adapter.id, capture: archive.capture },
      archive.reference(saved),
    );
    return { page: saved };
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
