import type { RetainedPublication } from "@crawl-automation/platform";
import type { HttpCapture } from "../capture/http-capture.js";
import { OriginalHtmlArchive } from "../capture/original-html-archive.js";
import type { ChannelRegistry } from "../registry.js";
import type { CaptureRequest, ProductCaptureResult } from "./capture-request.js";
import { ProductCapture } from "./product-capture.js";
import type { ProductSourcePlans } from "./source-plans.js";
import { channelErrors } from "../errors.js";
import { capturedPage, type CapturedPage } from "./captured-page.js";
import type { ListingSighting } from "./listing-sighting.js";

/** A page read in the browser: its listing and archive, or the listing's unlisted sighting. */
export type BrowserCaptureResult =
  | {
      status: "captured";
      listingId: string;
      variantId: string | null;
      archiveKey: string;
      /** Present when the adapter plans its own formula; absent for formula-family-only channels. */
      planned?: Omit<Extract<ProductCaptureResult, { status: "captured" }>, "page">;
      /** What the page showed, for the metrics history (recorded by the pipeline, not passed to the workflow). */
      page: CapturedPage;
    }
  | { status: "sighted"; listingId: string; variantId: string | null; sighting: ListingSighting };

/**
 * Archive-first browser capture. Adapters with planning publish the normal formula handoff;
 * formula-family-only adapters retain the original listing/archive result.
 */
export class BrowserProductCapture {
  constructor(
    private readonly deps: {
      registry: ChannelRegistry;
      http: HttpCapture;
      publication: RetainedPublication;
      sourcePlans?: ProductSourcePlans;
    },
  ) {}

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<BrowserCaptureResult> {
    const adapter = this.deps.registry.forCapture(request.channel, "browser");
    if (adapter.planning) {
      return this.capturePlanned(request, signal);
    }
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

  private async capturePlanned(
    request: CaptureRequest,
    signal: AbortSignal,
  ): Promise<BrowserCaptureResult> {
    const sourcePlans = this.deps.sourcePlans;
    if (!sourcePlans) {
      throw channelErrors.create("CHANNEL.PLANNING_UNSUPPORTED");
    }
    const result = await new ProductCapture({
      ...this.deps,
      sourcePlans,
      mode: "browser",
    }).capture(request, signal);
    if (result.status !== "captured") {
      return result;
    }
    const { page, ...planned } = result;
    return {
      status: "captured",
      listingId: planned.sourcePlan.owner.listingId,
      variantId: planned.sourcePlan.owner.variantId,
      archiveKey: page.archive.objectKey,
      page,
      planned,
    };
  }
}
