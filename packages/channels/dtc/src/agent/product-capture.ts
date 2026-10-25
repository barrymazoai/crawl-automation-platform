import {
  type BrowserCaptureResult,
  type CaptureRequest,
  type ProductSourcePlans,
  type ArchivedHtml,
} from "@crawl-automation/channels-core";
import type { RetainedPublication } from "@crawl-automation/platform";
import { createDtcAdapter } from "../adapter.js";
import { siteForUrl } from "../address.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { DtcCaptureAgent } from "./runner.js";
import { movedProductSighting } from "./moved-product.js";
import { agentHtmlArchive, saveAgentOriginal } from "./html-archive.js";
import { readCapturedProduct } from "./product-record.js";
import { capturedProductProjection } from "./product-projection.js";
import { dtcAgentErrors } from "./errors.js";
import { capturedBrandSighting } from "./product-sighting.js";
import { DtcVariantHandoffs } from "./variant-handoffs.js";
import { nativeCaptureResult } from "./product-result.js";
import { scopedOutcome, type DtcProductScope } from "./product-scope.js";
import { neverCollectFromHtml } from "./never-collect.js";
import { saveCapturedImages } from "./product-images.js";

export class DtcAgentProductCapture {
  constructor(
    private readonly deps: {
      agent: Pick<DtcCaptureAgent, "capture">;
      sites: readonly DtcSitePolicy[];
      publication: RetainedPublication;
      sourcePlans: ProductSourcePlans;
      productScope: Pick<DtcProductScope, "review">;
      routeId: string;
      egressId: string;
    },
  ) {}

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<BrowserCaptureResult> {
    const planning = { ...this.planning(request), parserVersion: "dtc-agent/1" as const };
    const harvested = await this.harvest(request, signal);
    if ("moved" in harvested) {
      return harvested.moved;
    }
    const { captured, retained, original } = harvested;
    const site = siteForUrl(request.url, this.deps.sites);
    const sighting = this.sighting(request, { site, retained, original });
    if (sighting) {
      return sighting;
    }
    await this.saveImages(
      { prefix: captured.prefix, url: request.url, images: retained.images },
      signal,
    );
    const skipped = neverCollectFromHtml({
      html: retained.html,
      url: request.url,
      site,
      operationId: request.operationId,
    });
    if (skipped) {
      return skipped;
    }
    const parsed = capturedProductProjection({
      ...retained,
      site,
      url: request.url,
      sourceUrl: request.sourceUrl,
    });
    const excluded = await this.scope(request, { retained, original, parsed }, signal);
    if (excluded) {
      return excluded;
    }
    return this.complete(
      { ...captured, ...retained, request, site, parsed, planning, original },
      signal,
    );
  }

  private async scope(
    request: CaptureRequest,
    input: {
      retained: Awaited<ReturnType<typeof readCapturedProduct>>;
      original: ArchivedHtml;
      parsed: ReturnType<typeof capturedProductProjection>;
    },
    signal: AbortSignal,
  ) {
    const { retained, original, parsed } = input;
    const { operationId, url } = request;
    return scopedOutcome({ ...parsed, source: original.source, operationId }, () =>
      this.deps.productScope.review(
        {
          operationId,
          url,
          source: original.source,
          fields: {
            ...retained.record.fields,
            ...(retained.detailsHtml ? { html: retained.detailsHtml } : {}),
          },
          variants: retained.record.variants,
        },
        signal,
      ),
    );
  }

  private async complete(
    input: Parameters<DtcVariantHandoffs["publish"]>[0] & { original: ArchivedHtml },
    signal: AbortSignal,
  ) {
    const { request, parsed, planning, original } = input;
    const sourcePlan = await this.deps.sourcePlans.publish(request, { parsed, planning }, signal);
    const expanded = await this.expand(input, signal);
    return nativeCaptureResult({
      request,
      parsed,
      sourcePlan,
      original,
      variants: expanded.variants,
      currency: input.record.fields.currency,
    });
  }

  private sighting(
    request: CaptureRequest,
    input: {
      site: DtcSitePolicy;
      retained: Awaited<ReturnType<typeof readCapturedProduct>>;
      original: ArchivedHtml;
    },
  ) {
    return capturedBrandSighting({
      request,
      site: input.site,
      ...input.retained,
      archiveKey: input.original.source.objectKey,
    });
  }

  private async expand(input: Parameters<DtcVariantHandoffs["publish"]>[0], signal: AbortSignal) {
    if (input.record.variants.length < 2) {
      return {};
    }
    return { variants: await new DtcVariantHandoffs(this.deps).publish(input, signal) };
  }

  private async harvest(request: CaptureRequest, signal: AbortSignal) {
    const archive = agentHtmlArchive(this.deps, request);
    await archive.beginDownload(signal);
    const captured = await this.deps.agent.capture(
      {
        operationId: request.operationId,
        url: request.url,
        mode: "product",
        scope: { sourceUrl: request.sourceUrl, selectedProductOnly: true },
      },
      signal,
    );
    if (captured.moved) {
      return {
        moved: await movedProductSighting({
          request,
          archive,
          moved: captured.moved,
          sites: this.deps.sites,
          routeId: this.deps.routeId,
          egressId: this.deps.egressId,
          signal,
        }),
      };
    }
    const retained = await readCapturedProduct({
      ...captured,
      url: request.url,
      requireObservedMethod: captured.captureContract !== "dtc-materials/1",
    });
    const original = await saveAgentOriginal({
      archive,
      retained,
      routeId: this.deps.routeId,
      egressId: this.deps.egressId,
      signal,
    });
    return { captured, retained, original };
  }

  private planning(request: CaptureRequest) {
    const planning = createDtcAdapter(this.deps.sites, request.sourceUrl).planning;
    if (!planning) {
      throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
    }
    return planning;
  }

  private saveImages(
    input: {
      prefix: string;
      url: string;
      images: Parameters<typeof saveCapturedImages>[1]["images"];
    },
    signal: AbortSignal,
  ) {
    return saveCapturedImages(this.deps.publication, input, signal);
  }
}
