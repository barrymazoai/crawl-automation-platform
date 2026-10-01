import type {
  ListedProduct,
  ListingPage,
  ListingNameResolution,
  ListingScanMetrics,
} from "@crawl-automation/channels-core";

/** Everything one brand's listing showed: its pages, its products (families expanded) and what it cost. */
export interface BrandListing {
  pages: ListingPage[];
  products: ListedProduct[];
  families: number;
  unresolvedFamilies: number;
  credits: number;
  /** The reader proved every product was listed, and every family's members were read. */
  full: boolean;
  statedTotal?: number | null;
  code?: string | null;
  cooldownRequested?: boolean;
  metrics?: ListingScanMetrics;
  /** A reader explicitly reported a capped listing. */
  capped?: boolean;
  soldHere?: boolean;
  nameResolution?: ListingNameResolution;
}
