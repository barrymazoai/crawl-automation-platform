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
    const planning = this.planning(request);
    const { captured, retained, original } = await this.harvest(request, signal);
    const site = siteForUrl(request.url, this.deps.sites);
    const sighting = capturedBrandSighting({
      request,
      site,
      ...retained,
      archiveKey: original.source.objectKey,
    });
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
    const sourcePlan = await this.deps.sourcePlans.publish(
      request,
      {
        parsed,
        planning: { ...planning, parserVersion: "dtc-agent/1" },
      },
      signal,
    );
    return captureResult({ request, parsed, sourcePlan, original });
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
    const retained = await readCapturedProduct({ ...captured, url: request.url });
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

function captureResult(input: {
  request: CaptureRequest;
  parsed: ReturnType<typeof capturedProductProjection>;
  sourcePlan: Awaited<ReturnType<ProductSourcePlans["publish"]>>;
  original: ArchivedHtml;
}): BrowserCaptureResult {
  const { request, parsed, sourcePlan, original } = input;
  const page = {
    channel: "dtc" as const,
    url: request.url,
    ...parsed.identity,
    externalId: parsed.identity.listingId,
    capturedAt: original.capturedAt,
    commerce: parsed.commerce,
    archive: { objectKey: original.source.objectKey, sha256: original.source.sha256 },
  };
  return {
    status: "captured",
    ...parsed.identity,
    archiveKey: page.archive.objectKey,
    page,
    planned: {
      status: "captured",
      sourcePlan,
      factsComplete: parsed.facts.complete,
      labelText: parsed.facts.text,
      family: null,
    },
  };
}
