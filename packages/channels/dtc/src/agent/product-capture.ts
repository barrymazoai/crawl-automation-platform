import {
  OriginalHtmlArchive,
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
import { readCapturedProduct } from "./product-record.js";
import { capturedProductProjection } from "./product-projection.js";
import { dtcAgentErrors } from "./errors.js";
import { capturedBrandSighting } from "./product-sighting.js";
import { DtcVariantHandoffs } from "./variant-handoffs.js";
import { nativeCaptureResult } from "./product-result.js";
import { scopeProductOutcome, type DtcProductScope } from "./product-scope.js";

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
    const { captured, retained, original } = await this.harvest(request, signal);
    const site = siteForUrl(request.url, this.deps.sites);
    const sighting = this.sighting(request, { site, retained, original });
    if (sighting) {
      return sighting;
    }
    await this.saveImages(
      { prefix: captured.prefix, url: request.url, images: retained.images },
      signal,
    );
    const parsed = capturedProductProjection({
      ...retained,
      site,
      url: request.url,
      sourceUrl: request.sourceUrl,
    });
    const excluded = await this.scope(
      request,
      { retained, original, identity: parsed.identity },
      signal,
    );
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
      identity: { listingId: string; variantId: string | null };
    },
    signal: AbortSignal,
  ) {
    const { retained, original, identity } = input;
    const scope = await this.deps.productScope.review(
      {
        operationId: request.operationId,
        url: request.url,
        source: original.source,
        fields: retained.record.fields,
        variants: retained.record.variants,
      },
      signal,
    );
    return scopeProductOutcome({ scope, operationId: request.operationId, identity });
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
    const archive = this.archive(request);
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
    const retained = await readCapturedProduct({
      ...captured,
      url: request.url,
      requireObservedMethod: captured.captureContract !== "legacy-harvest/1",
    });
    const original = await this.saveOriginal(archive, retained, signal);
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
      images: Awaited<ReturnType<typeof readCapturedProduct>>["images"];
    },
    signal: AbortSignal,
  ) {
    return this.deps.publication.publish(
      `${input.prefix}/images.json`,
      Buffer.from(
        JSON.stringify({ version: "dtc-agent-images/1", url: input.url, images: input.images }),
      ),
      "application/json",
      signal,
    );
  }

  private archive(request: CaptureRequest) {
    const adapter = createDtcAdapter(this.deps.sites, request.sourceUrl);
    const address = adapter.productAddress(request.url);
    return new OriginalHtmlArchive(this.deps.publication, {
      channel: "dtc",
      maxBytes: adapter.httpPolicy.maxBytes,
      capture: {
        operationId: request.operationId,
        sessionId: request.operationId,
        sourceId: request.sourceId,
        ...address,
      },
    });
  }

  private saveOriginal(
    archive: OriginalHtmlArchive,
    retained: Awaited<ReturnType<typeof readCapturedProduct>>,
    signal: AbortSignal,
  ) {
    return archive.save(
      retained.html,
      {
        mode: "browser",
        provider: "codex-ego-native/1",
        routeId: this.deps.routeId,
        egressId: this.deps.egressId,
        finalUrl: retained.record.productUrl,
      },
      signal,
    );
  }
}
