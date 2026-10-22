import {
  OriginalHtmlArchive,
  brandScanErrors,
  platformPageErrors,
  channelErrors,
  type BrowserReader,
} from "@crawl-automation/channels-core";
import { errorCodeOf, ListScrollResultSchema, type BrowserPage } from "@crawl-automation/platform";
import type { RetainedPublication } from "@crawl-automation/platform";
import { z } from "zod";
import { DTC_PAGE_LIMITS, type DtcSitePolicy } from "./site-policy.js";
import { dtcIdentityKey } from "./identity.js";
import { dtcBrandSource } from "./brand-source.js";
import { shopifyCatalogPageUrl } from "./address.js";

const Proof = z.object({
  url: z.string(),
  ready: z.boolean(),
  status: z.number().nullable(),
  scroll: ListScrollResultSchema.pick({ rounds: true, ended: true }),
});

export interface DtcCatalogRead {
  scanId: string;
  position: number;
  url: string;
  site: DtcSitePolicy;
  sourceUrl?: string;
}

/** The page reader owns closure. No successful read is returned until HTML and scroll proof are retained. */
export class DtcCatalogPages {
  constructor(private readonly deps: { browser: BrowserReader; publication: RetainedPublication }) {
    if (deps.browser.provider !== "ego-lite/2") {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED");
    }
  }

  async read(request: DtcCatalogRead, signal: AbortSignal) {
    const archive = this.archive(request);
    const proofKey = `${archive.prefix}/catalog-proof.json`;
    const saved = await archive.inspect(signal);
    if (saved) {
      const proof = await this.deps.publication.remote.read(proofKey, 65_536, signal);
      if (!proof) {
        throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED");
      }
      const retained = {
        ...Proof.parse(JSON.parse(Buffer.from(proof).toString("utf8"))),
        html: Buffer.from(saved.bytes).toString("utf8"),
        archiveKey: saved.source.objectKey,
      };
      this.checkDrawn(retained, request.url);
      return retained;
    }
    await archive.beginDownload(signal);
    return this.draw(request, archive, signal);
  }

  private async draw(request: DtcCatalogRead, archive: OriginalHtmlArchive, signal: AbortSignal) {
    const page = await this.browserPage(request.url, signal);
    if (Buffer.byteLength(page.html) > DTC_PAGE_LIMITS.maxBytes) {
      throw platformPageErrors.create("DTC.PAGE_LIMIT");
    }
    const original = await archive.save(
      Buffer.from(page.html),
      {
        mode: "browser",
        routeId: "dtc-catalog",
        egressId: "browser",
        provider: this.deps.browser.provider,
        finalUrl: page.url,
      },
      signal,
    );
    const proof = Proof.parse(page);
    await this.saveProof(`${archive.prefix}/catalog-proof.json`, proof, signal);
    this.checkDrawn(page, request.url);
    return {
      ...proof,
      html: Buffer.from(original.bytes).toString("utf8"),
      archiveKey: original.source.objectKey,
    };
  }

  private async browserPage(url: string, signal: AbortSignal): Promise<BrowserPage> {
    let page: BrowserPage;
    try {
      page = await this.deps.browser.read(
        { url, readySelector: "body", timeoutMs: DTC_PAGE_LIMITS.timeoutMs },
        signal,
      );
    } catch (error) {
      const failure = (error as { details?: { failure?: { message?: unknown } } })?.details
        ?.failure;
      if (
        !signal.aborted &&
        errorCodeOf(error) === "BROWSER.UNAVAILABLE" &&
        typeof failure?.message === "string" &&
        /waitForSelector.*timed out/i.test(failure.message)
      ) {
        throw platformPageErrors.create("DTC.CATALOG_READY_TIMEOUT", { cause: error });
      }
      throw error;
    }
    return page;
  }

  private async saveProof(proofKey: string, proof: z.infer<typeof Proof>, signal: AbortSignal) {
    await this.deps.publication.publish(
      proofKey,
      Buffer.from(JSON.stringify(proof)),
      "application/json",
      signal,
    );
    const retained = await this.deps.publication.remote.read(proofKey, 65_536, signal);
    if (!retained || Buffer.from(retained).toString("utf8") !== JSON.stringify(proof)) {
      throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED");
    }
  }

  private archive(request: DtcCatalogRead) {
    const source = dtcBrandSource(request.sourceUrl ?? request.site.catalogUrl ?? request.url, [
      request.site,
    ]);
    if (request.url !== shopifyCatalogPageUrl(source.catalogUrl, request.site, request.position)) {
      throw channelErrors.create("CHANNEL.URL_REJECTED", { details: { url: request.url } });
    }
    const multi = request.site.kind === "multi-brand";
    const operation = `catalog-${request.scanId}-${request.position}`;
    return new OriginalHtmlArchive(this.deps.publication, {
      channel: "dtc",
      maxBytes: DTC_PAGE_LIMITS.maxBytes,
      capture: {
        operationId: multi ? dtcIdentityKey(source.sourceId, operation) : operation,
        sessionId: request.scanId,
        url: request.url,
        sourceId: multi ? source.sourceId : dtcIdentityKey(request.site.siteKey, "site"),
        listingId: dtcIdentityKey(request.site.siteKey, multi ? source.catalogUrl : "catalog"),
        variantId: null,
      },
    });
  }

  private checkDrawn(page: BrowserPage, expectedUrl: string) {
    if (page.url !== expectedUrl || (page.status !== null && page.status !== 200)) {
      throw platformPageErrors.create("DTC.CATALOG_HTTP_STATUS", {
        details: { status: page.status, finalUrl: page.url },
      });
    }
    if (!page.ready) {
      throw platformPageErrors.create("DTC.CATALOG_READY_TIMEOUT");
    }
  }
}
