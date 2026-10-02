import {
  OriginalHtmlArchive,
  channelErrors,
  type BrowserReader,
} from "@crawl-automation/channels-core";
import { SiteUrlSchema } from "@crawl-automation/v3-contracts";
import type { RetainedPublication } from "@crawl-automation/platform";
import { DTC_PAGE_LIMITS } from "../site-policy.js";
import { dtcIdentityKey } from "../identity.js";
import { analysisErrors } from "./errors.js";

export interface AnalysisPage {
  url: string;
  html: string;
  archiveKey: string;
}
export interface AnalysisPages {
  read(url: string, signal: AbortSignal): Promise<AnalysisPage>;
}

/** Only Ego navigations; JSON endpoints are opened as browser pages, never fetched over HTTP. */
export class SiteAnalysisPages implements AnalysisPages {
  private readonly pages = new Map<string, AnalysisPage>();
  private readonly visited = new Set<string>();
  private readonly failures = new Map<string, unknown>();
  constructor(
    private readonly deps: {
      browser: BrowserReader;
      publication: RetainedPublication;
      analysisId: string;
      maxPages: number;
      evidence(key: string): Promise<void>;
    },
  ) {
    if (deps.browser.provider !== "ego-lite/2") {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED");
    }
  }

  async read(raw: string, signal: AbortSignal): Promise<AnalysisPage> {
    signal.throwIfAborted();
    const url = new URL(SiteUrlSchema.parse(raw)).href;
    const cached = this.pages.get(url);
    if (cached) {
      return cached;
    }
    if (this.failures.has(url)) {
      throw this.failures.get(url);
    }
    if (this.visited.size >= this.deps.maxPages) {
      throw analysisErrors.create("DTC.ANALYSIS_LIMIT");
    }
    this.visited.add(url);
    try {
      const page = await this.observe(url, signal);
      this.pages.set(url, page);
      return page;
    } catch (error) {
      this.failures.set(url, error);
      throw error;
    }
  }

  private async observe(url: string, signal: AbortSignal): Promise<AnalysisPage> {
    const archive = this.archive(url);
    const saved = await this.capture(url, archive, signal);
    await this.deps.evidence(saved.source.objectKey);
    const finalUrl = saved.finalUrl ?? url;
    if (new URL(finalUrl).origin !== new URL(url).origin) {
      throw analysisErrors.create("DTC.ANALYSIS_REDIRECT", { details: { url, finalUrl } });
    }
    const page = {
      url: finalUrl,
      html: Buffer.from(saved.bytes).toString("utf8"),
      archiveKey: saved.source.objectKey,
    };
    return page;
  }

  private async capture(url: string, archive: OriginalHtmlArchive, signal: AbortSignal) {
    const retained = await archive.inspect(signal);
    if (retained) {
      return retained;
    }
    await archive.beginDownload(signal);
    const page = await this.deps.browser.read(
      { url, readySelector: "body", timeoutMs: DTC_PAGE_LIMITS.timeoutMs },
      signal,
    );
    // Even errors/challenges are evidence. Interpretation only starts after read-back verification.
    const saved = await archive.save(
      Buffer.from(page.html),
      {
        mode: "browser",
        routeId: "dtc-site-analysis",
        egressId: "browser",
        provider: this.deps.browser.provider,
        finalUrl: page.url,
      },
      signal,
    );
    if (!page.ready) {
      await this.deps.evidence(saved.source.objectKey);
      throw analysisErrors.create("DTC.ANALYSIS_UNVERIFIED");
    }
    return saved;
  }

  private archive(url: string) {
    const identity = dtcIdentityKey(this.deps.analysisId, url);
    return new OriginalHtmlArchive(this.deps.publication, {
      channel: "dtc",
      maxBytes: DTC_PAGE_LIMITS.maxBytes,
      capture: {
        operationId: `site-analysis-${identity}`,
        sessionId: this.deps.analysisId,
        url,
        sourceId: identity,
        listingId: identity,
        variantId: null,
      },
    });
  }
}
