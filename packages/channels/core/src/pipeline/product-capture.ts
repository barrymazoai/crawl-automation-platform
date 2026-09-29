import type { RetainedPublication } from "@crawl-automation/v3-artifacts";
import type { ChannelAdapter, ProductAddress } from "../adapter.js";
import { HttpCapture } from "../capture/http-capture.js";
import { OriginalHtmlArchive } from "../capture/original-html-archive.js";
import { channelErrors } from "../errors.js";
import type { ChannelRegistry } from "../registry.js";
import type { CaptureRequest, ProductCaptureResult } from "./capture-request.js";
import type { ProductSourcePlans } from "./source-plans.js";

export interface ProductCaptureDeps {
  registry: ChannelRegistry;
  http: HttpCapture;
  publication: RetainedPublication;
  sourcePlans: ProductSourcePlans;
}

/**
 * The pipeline's capture step for any channel: archive the original page, let the channel's adapter read it,
 * then hand the formula planner its input. The caller holds the capture-lane permit.
 */
export class ProductCapture {
  constructor(private readonly deps: ProductCaptureDeps) {}

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<ProductCaptureResult> {
    const adapter = this.deps.registry.forCapture(request.channel, "http");
    const planning = adapter.planning;
    if (!planning) {
      throw channelErrors.create("CHANNEL.PLANNING_UNSUPPORTED", {
        details: { channel: request.channel },
      });
    }
    const address = adapter.productAddress(request.url);
    const captured = await this.deps.http.capture(
      adapter,
      this.archive(adapter, { request, address }),
      signal,
    );
    if (captured.status === "sighting") {
      const { listingId, variantId } = address;
      return { status: "sighted", listingId, variantId, sighting: captured.sighting };
    }
    const sourcePlan = await this.deps.sourcePlans.publish(
      request,
      { parsed: captured.parsed, planning },
      signal,
    );
    const { parsed } = captured;
    return {
      status: "captured",
      sourcePlan,
      factsComplete: parsed.facts.complete,
      labelText: parsed.facts.text,
      family: adapter.productFamily?.(parsed) ?? null,
    };
  }

  private archive(
    adapter: ChannelAdapter,
    target: { request: CaptureRequest; address: ProductAddress },
  ): OriginalHtmlArchive {
    const { request, address } = target;
    return new OriginalHtmlArchive(this.deps.publication, {
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
  }
}
