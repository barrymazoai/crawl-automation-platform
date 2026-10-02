import { errorCodeOf, isAppError } from "@crawl-automation/platform";
import type {
  AnalyzedBrand,
  SiteAnalysisLimits,
  SiteAnalysisResult,
} from "@crawl-automation/v3-contracts";
import { SiteUrlSchema } from "@crawl-automation/v3-contracts";
import { inventory } from "./inventory.js";
import type { AnalysisRead } from "./model.js";
import { brandPages, childBrands } from "./links.js";
import { candidates, verifyCatalog } from "./verify.js";
import type { AnalysisPage, AnalysisPages } from "./pages.js";

/** Finite, sequential browser analysis. Only the root site's explicit brand links permit another origin. */
export class DtcSiteAnalyzer {
  constructor(
    private readonly pages: AnalysisPages,
    private readonly limits: SiteAnalysisLimits,
  ) {}

  async analyze(url: string, signal: AbortSignal): Promise<SiteAnalysisResult> {
    const result: SiteAnalysisResult = {
      state: "completed",
      brands: [],
      archiveKeys: [],
      reasons: [],
    };
    const read: AnalysisRead = { pages: this.recorded(result), limits: this.limits, signal };
    try {
      await this.discover(SiteUrlSchema.parse(url), read, result);
    } catch (error) {
      if (!reviewable(error)) {
        throw error;
      }
      result.reasons.push(errorCodeOf(error) ?? "Unverified site data");
    }
    if (!result.brands.length) {
      result.reasons.push("No verified product brands found");
    }
    if (result.brands.some((brand) => brand.status !== "verified")) {
      result.reasons.push("Some brand catalogs need review");
    }
    if (result.reasons.length) {
      result.state = "needs-review";
    }
    return result;
  }

  private recorded(result: SiteAnalysisResult): AnalysisPages {
    return {
      read: async (url, signal) => {
        const page = await this.pages.read(url, signal);
        if (!result.archiveKeys.includes(page.archiveKey)) {
          result.archiveKeys.push(page.archiveKey);
        }
        return page;
      },
    };
  }

  private async discover(url: string, read: AnalysisRead, result: SiteAnalysisResult) {
    const home = await read.pages.read(url, read.signal);
    await this.domain({ home, discoveredFrom: "platform-data" }, read, result);
    if (this.overCap(result)) {
      return;
    }
    const links = childBrands(home, /\/(?:our-)?brands\/?$/i.test(new URL(home.url).pathname));
    for (const url of brandPages(home)) {
      links.push(...childBrands(await read.pages.read(url, read.signal), true));
    }
    const domains = new Map(links.map((link) => [new URL(link.url).origin, link]));
    domains.delete(new URL(home.url).origin);
    if (domains.size > this.limits.maxDomains || domains.size > this.limits.maxBrands) {
      result.reasons.push("Sub-brand domain cap exceeded; nothing may be applied");
      return;
    }
    for (const [origin, link] of domains) {
      const child = await read.pages.read(origin, read.signal);
      await this.domain({ home: child, discoveredFrom: link.discoveredFrom }, read, result);
      if (this.overCap(result)) {
        return;
      }
    }
  }

  private async domain(
    input: { home: AnalysisPage; discoveredFrom: AnalyzedBrand["discoveredFrom"] },
    read: AnalysisRead,
    result: SiteAnalysisResult,
  ) {
    const { home, discoveredFrom } = input;
    const data = await inventory(home, read);
    const brands = candidates(home, data).map((brand) => ({ ...brand, discoveredFrom }));
    result.brands.push(...brands);
    if (!brands.length && discoveredFrom !== "platform-data") {
      result.reasons.push(`Sub-brand has no verified product data: ${home.url}`);
    }
    if (this.overCap(result)) {
      return;
    }
    if (brands.length && !data.exact) {
      result.reasons.push(`Incomplete product inventory: ${home.url}`);
    }
    for (const brand of brands) {
      await this.verify(brand, read);
    }
  }

  private async verify(brand: AnalyzedBrand, read: AnalysisRead) {
    try {
      Object.assign(brand, await verifyCatalog(brand, read));
    } catch (error) {
      if (!reviewable(error)) {
        throw error;
      }
      brand.reason = errorCodeOf(error) ?? "Catalog unverified";
      if (errorCodeOf(error) === "DTC.ANALYSIS_LIMIT") {
        throw error;
      }
    }
  }

  private overCap(result: SiteAnalysisResult): boolean {
    if (result.brands.length <= this.limits.maxBrands) {
      return false;
    }
    result.reasons.push("Brand cap exceeded; nothing may be applied");
    return true;
  }
}
function reviewable(error: unknown) {
  return (
    isAppError(error) &&
    [
      "DTC.ANALYSIS_LIMIT",
      "CHANNEL.URL_REJECTED",
      "DTC.ANALYSIS_REDIRECT",
      "DTC.LISTING_UNVERIFIED",
      "DTC.ANALYSIS_UNVERIFIED",
    ].includes(error.code)
  );
}
