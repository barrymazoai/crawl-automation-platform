import type { SiteAnalysisLimits } from "@crawl-automation/v3-contracts";
import type { StorePlatform } from "@crawl-automation/channels-core";
import type { BrandProduct, BrandTaxon } from "./data.js";
import type { AnalysisPages } from "./pages.js";
export interface Inventory {
  platform: StorePlatform;
  products: BrandProduct[];
  exact: boolean;
  catalogs: BrandTaxon[];
  whole: string | null;
}
export interface AnalysisRead {
  pages: AnalysisPages;
  limits: SiteAnalysisLimits;
  signal: AbortSignal;
}
