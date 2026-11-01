import { errorCodeOf } from "@crawl-automation/platform";
import type { ChannelAdapter, FetchedPage, ParsedProduct } from "../adapter.js";
import { channelErrors } from "../errors.js";
import {
  identitySighting,
  notFoundSighting,
  type ListingSighting,
} from "../pipeline/listing-sighting.js";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";
import type { PageFetcher } from "./page-fetch.js";
import { isVerification } from "./challenge-escalation.js";
import { decodeHtml } from "./read-html.js";
import { htmlCaptureErrors, type HtmlCaptureRecords } from "./html-capture-records.js";
import type { HtmlCaptureRequest } from "./html-capture-model.js";
import { recoverOriginal } from "./recover-original.js";
import { captureOtherOfferRetry } from "./other-offer-retry.js";
import { movedPage } from "./moved-page.js";

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
    const download = await this.archivedOrAcquire(adapter, archive, signal);
    if ("sighting" in download) {
      return { status: "sighting", sighting: download.sighting };
    }
    const saved = download.page;
    // A saved verification page (e.g. one archived before 2026-10-24) is never a sighting or a product.
    if (isVerification(adapter.httpPolicy, { ...saved, url: archive.capture.url })) {
      throw channelErrors.create("CAPTURE.ACCESS_CHALLENGE", {
        details: {
          archiveKey: saved.source.objectKey,
          evidence: { objectKey: saved.source.objectKey },
        },
      });
    }
    const moved = movedPage(adapter, archive, saved);
    if (moved) {
      return { status: "sighting", sighting: moved };
    }
    return this.readProduct(adapter, archive, saved);
  }

  private async archivedOrAcquire(
    adapter: ChannelAdapter,
    archive: OriginalHtmlArchive,
    signal: AbortSignal,
  ): Promise<Download> {
    const first = await archive.inspect(signal);
    if (!first) {
      return this.acquire(adapter, archive, signal);
    }
    const retryArchive = adapter.id === "amazon" ? archive.otherOfferRetry() : null;
    const retry = await retryArchive?.inspect(signal);
    await this.records?.complete(
      { channel: adapter.id, capture: archive.capture },
      retry && retryArchive ? retryArchive.reference(retry) : archive.reference(first),
    );
    return { page: retry ?? first };
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
    const first = await archive.save(page.bytes, page.fetchedVia, signal);
    const retry = await captureOtherOfferRetry({
      pages: this.pages,
      adapter,
      archive,
      first,
      signal,
      isOtherOffer: () => {
        try {
          if (movedPage(adapter, archive, first)) {
            return false;
          }
          const observed = this.readProduct(adapter, archive, first);
          return (
            observed.status === "page" && observed.parsed.commerce?.priceStatus === "other_offer"
          );
        } catch {
          return false;
        }
      },
    });
    const saved = retry?.page ?? first;
    const selectedArchive = retry?.archive ?? archive;
    await this.records?.complete(
      { channel: adapter.id, capture: archive.capture },
      selectedArchive.reference(saved),
    );
    return { page: saved };
  }
}
