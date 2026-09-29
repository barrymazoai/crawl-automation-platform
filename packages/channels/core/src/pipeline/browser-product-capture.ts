import type { RetainedPublication } from "@crawl-automation/v3-artifacts";
import type { HttpCapture } from "../capture/http-capture.js";
import { OriginalHtmlArchive } from "../capture/original-html-archive.js";
import type { ChannelRegistry } from "../registry.js";
import type { CaptureRequest } from "./capture-request.js";
import { capturedPage, type CapturedPage } from "./captured-page.js";
import type { ListingSighting } from "./listing-sighting.js";

/** A page read in the browser: its listing and archive, or the listing's unlisted sighting. */
export type BrowserCaptureResult =
  | {
      status: "captured";
      listingId: string;
      variantId: string | null;
      archiveKey: string;
      /** What the page showed, for the metrics history (recorded by the pipeline, not passed to the workflow). */
      page: CapturedPage;
    }
  | { status: "sighted"; listingId: string; variantId: string | null; sighting: ListingSighting };

/**
 * Capture for a channel only a browser can read (Whole Foods): the same archive-first capture as every channel,
 * through the browser page fetcher. There is no formula planner here; the formula comes from the formula family.
 */
export class BrowserProductCapture {
  constructor(
    private readonly deps: {
      registry: ChannelRegistry;
      http: HttpCapture;
      publication: RetainedPublication;
    },
  ) {}

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<BrowserCaptureResult> {
    const adapter = this.deps.registry.forCapture(request.channel, "browser");
    const address = adapter.productAddress(request.url);
    const archive = new OriginalHtmlArchive(this.deps.publication, {
      channel: adapter.id,
      maxBytes: adapter.httpPolicy.maxBytes,
      capture: {
        operationId: request.operationId,
        sessionId: request.operationId,
        url: address.url,
        sourceId: request.sourceId,
        listingId: address.listingId,
        variantId: address.variantId,
      },
    });
    const captured = await this.deps.http.capture(adapter, archive, signal);
    const { listingId, variantId } = address;
    if (captured.status === "sighting") {
      return { status: "sighted", listingId, variantId, sighting: captured.sighting };
    }
    return {
      status: "captured",
      listingId,
      variantId,
      archiveKey: captured.archiveKey,
      page: capturedPage(adapter, address, captured),
    };
  }
}
