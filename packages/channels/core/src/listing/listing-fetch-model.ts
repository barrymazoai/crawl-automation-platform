import type { ChannelId } from "@crawl-automation/v3-contracts";
import type { ScraperApiOptions } from "@crawl-automation/platform";

/** One listing page to read for a scan: where it is archived (`label`) and what it answers with. */
export interface ListingPageRequest {
  scanId: string;
  channel: ChannelId;
  url: string;
  /** Unique within the scan, e.g. `page-2` or `family-GNCTotalLean`. */
  label: string;
  answer: "html" | "json";
  origins: readonly string[];
  maxBytes: number;
  /** Bounds the paid request only; a received original is still fully archived. */
  timeoutMs?: number;
  /** Reader-required transport options, applied after configured channel defaults. */
  options?: Partial<ScraperApiOptions>;
}

/** A listing page's text and where its original bytes are archived. */
export interface ListingPageRead {
  body: string;
  archiveKey: string;
  creditCost: number | null;
  fromArchive: boolean;
  /** Original billed cost when this observation is reused. */
  originalCreditCost?: number | null;
}
