import type { RetainedPublication } from "@crawl-automation/platform";
import type { ChannelAdapter, ProductAddress } from "../adapter.js";
import { HttpCapture } from "../capture/http-capture.js";
import { OriginalHtmlArchive } from "../capture/original-html-archive.js";
import { channelErrors } from "../errors.js";
import type { ChannelRegistry } from "../registry.js";
import type {
  CaptureRequest,
  ProductCaptureResult,
  ChannelCaptureResult,
  DiscoveredVariant,
} from "./capture-request.js";
import { capturedPage } from "./captured-page.js";
import { nonSupplementPath } from "../product-scope.js";
import type { ProductSourcePlans } from "./source-plans.js";
import type { CaptureMode } from "../capture.js";

export interface ProductCaptureDeps {
  registry: ChannelRegistry;
  http: HttpCapture;
  publication: RetainedPublication;
  sourcePlans: ProductSourcePlans;
  mode?: CaptureMode;
}

/**
 * The pipeline's capture step for any channel: archive the original page, let the channel's adapter read it,
 * then hand the formula planner its input. The caller holds the capture-lane permit.
 */
export class ProductCapture {
  constructor(private readonly deps: ProductCaptureDeps) {}

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<ProductCaptureResult> {
    const adapter = this.deps.registry.forCapture(
      request.channel,
      this.deps.mode ?? "http",
      request.sourceUrl,
    );
    const planning = adapter.planning;
    if (!planning) {
      throw channelErrors.create("CHANNEL.PLANNING_UNSUPPORTED", {
        details: { channel: request.channel },
      });
    }
    const { address, captured } = await this.read(adapter, request, signal);
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
      page: capturedPage(adapter, address, captured),
      ...discoveredVariants(adapter, address, parsed),
      ...nonSupplement(adapter, parsed.categories),
    };
  }

  /** Formula-family adapters capture metrics without requiring a local formula planner. */
  async captureForAdapter(
    request: CaptureRequest,
    signal: AbortSignal,
  ): Promise<ChannelCaptureResult> {
    const adapter = this.deps.registry.forCapture(
      request.channel,
      this.deps.mode ?? "http",
      request.sourceUrl,
    );
    if (adapter.planning || !adapter.formulaFamily) {
      return this.capture(request, signal);
    }
    const { address, captured } = await this.read(adapter, request, signal);
    const { listingId, variantId } = address;
    if (captured.status === "sighting") {
      return { status: "sighted", listingId, variantId, sighting: captured.sighting };
    }
    return {
      status: "captured-family",
      listingId,
      variantId,
      archiveKey: captured.archiveKey,
      page: capturedPage(adapter, address, captured),
      ...discoveredVariants(adapter, address, captured.parsed),
    };
  }

  private async read(adapter: ChannelAdapter, request: CaptureRequest, signal: AbortSignal) {
    const address = adapter.productAddress(request.url);
    const captured = await this.deps.http.capture(
      adapter,
      this.archive(adapter, { request, address }),
      signal,
    );
    return { address, captured };
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

const MAX_DISCOVERED = 200;

/** The page's variants other than the captured one, only for adapters that opt in. */
function discoveredVariants(
  adapter: ChannelAdapter,
  address: ProductAddress,
  parsed: { variants: ProductAddress[] },
): { discovered?: DiscoveredVariant[] } {
  if (!adapter.discoversVariants) {
    return {};
  }
  const seen = new Set([key(address)]);
  const discovered = parsed.variants.filter((variant) => {
    const id = key(variant);
    return seen.has(id) ? false : (seen.add(id), true);
  });
  return discovered.length
    ? {
        discovered: discovered
          .slice(0, MAX_DISCOVERED)
          .map(({ url, listingId, variantId }) => ({ url, listingId, variantId })),
      }
    : {};
}

function nonSupplement(adapter: ChannelAdapter, categories: string[] | undefined) {
  const path = nonSupplementPath(categories, adapter.nonSupplementCategories);
  return path ? { nonSupplement: path } : {};
}

function key(address: { listingId: string; variantId: string | null }) {
  return `${address.listingId}\u0000${address.variantId ?? ""}`;
}
