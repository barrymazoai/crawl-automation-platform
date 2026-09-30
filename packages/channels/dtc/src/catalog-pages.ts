import {
  OriginalHtmlArchive,
  brandScanErrors,
  checkPage,
  platformPageErrors,
  channelErrors,
  type BrowserReader,
} from "@crawl-automation/channels-core";
import type { BrowserPage } from "@crawl-automation/platform";
import type { RetainedPublication } from "@crawl-automation/platform";
import { z } from "zod";
import { DTC_PAGE_LIMITS, type DtcSitePolicy } from "./site-policy.js";
import { dtcIdentityKey } from "./identity.js";
import { dtcBrandSource } from "./brand-source.js";
import { catalogUrl } from "./address.js";

const Proof = z.object({
  url: z.string(),
  ready: z.literal(true),
  status: z.number().nullable(),
  scroll: z.object({
    rounds: z.number().int().nonnegative(),
    ended: z.enum(["none", "stable", "capped"]),
  }),
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
      return {
        ...Proof.parse(JSON.parse(Buffer.from(proof).toString("utf8"))),
        html: Buffer.from(saved.bytes).toString("utf8"),
        archiveKey: saved.source.objectKey,
      };
    }
    await archive.beginDownload(signal);
    return this.draw(request, archive, signal);
  }

  private async draw(request: DtcCatalogRead, archive: OriginalHtmlArchive, signal: AbortSignal) {
    const page = await this.deps.browser.read(
      {
        url: request.url,
        readySelector: `${request.site.catalog.catalogSelector}, ${request.site.catalog.emptySelector}`,
        timeoutMs: DTC_PAGE_LIMITS.timeoutMs,
        scroll: request.site.scroll,
      },
      signal,
    );
    this.checkDrawn(page);
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
    return {
      ...proof,
      html: Buffer.from(original.bytes).toString("utf8"),
      archiveKey: original.source.objectKey,
    };
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
    catalogUrl(request.url, request.site, source.catalogUrl);
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

  private checkDrawn(page: BrowserPage) {
    checkPage({
      status: page.status ?? 200,
      contentType: "text/html",
      contentEncoding: null,
      bytes: Buffer.from(page.html),
    });
    if (!page.ready || Buffer.byteLength(page.html) > DTC_PAGE_LIMITS.maxBytes) {
      throw platformPageErrors.create("DTC.LISTING_UNVERIFIED");
    }
  }
}
