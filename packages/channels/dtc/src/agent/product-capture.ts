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

export class DtcAgentProductCapture {
  constructor(
    private readonly deps: {
      agent: Pick<DtcCaptureAgent, "capture">;
      sites: readonly DtcSitePolicy[];
      publication: RetainedPublication;
      sourcePlans: ProductSourcePlans;
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
    const sourcePlan = await this.deps.sourcePlans.publish(request, { parsed, planning }, signal);
    const expanded = await this.expand(
      {
        ...captured,
        ...retained,
        request,
        site,
        parsed,
        planning,
      },
      signal,
    );
    return nativeCaptureResult({
      request,
      parsed,
      sourcePlan,
      original,
      variants: expanded.variants,
      currency: retained.record.fields.currency,
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
      requireObservedMethod: true,
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
