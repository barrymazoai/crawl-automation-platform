import { z } from "zod";
import type { AmazonChannel } from "@crawl-automation/v3-contracts";
import { domainOf } from "../brand-enrichment/run-records.js";

export const BRAND_COMPANY_CANDIDATE_LIMIT = 20;
export const BRAND_COMPANY_RECHECK_MS = 24 * 60 * 60 * 1000;
/** A matched brand's company is read again after a week: Supply Smart merges companies and changes websites. */
export const BRAND_COMPANY_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const BrandCompanyStatusSchema = z.enum(["matched", "unmatched", "ambiguous"]);
export type BrandCompanyStatus = z.infer<typeof BrandCompanyStatusSchema>;
export type BrandCompanyChannel = AmazonChannel | "gnc" | "swanson" | "wholefoods" | "costco";

export const MatchBrandsSchema = z.object({
  limit: z.number().int().min(1).max(500),
  recheckUnmatched: z.boolean().optional(),
  /**
   * Owner 2026-11-14: matched brands, least recently checked first, read against their company again (default: those
   * checked a week ago or earlier). A company merged in Supply Smart answers with its survivor, whose website the
   * brand then carries; a changed website replaces the brand's domain.
   */
  refreshMatched: z
    .object({
      limit: z.number().int().min(1).max(5000),
      checkedBefore: z.iso.datetime({ offset: true }).optional(),
    })
    .optional(),
});
export const ListSyncBrandsSchema = z.object({
  status: BrandCompanyStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export interface BrandCompanyMatch {
  brandId: string;
  status: BrandCompanyStatus;
  companyId: string | null;
  domain: string | null;
  matchedBy: string | null;
  candidates: string[];
  checkedAt: string;
}

/** Only brands with a latest completed marketplace queue item. Null match means never checked. */
export interface SyncBrand {
  brandId: string;
  name: string;
  productCounts: Record<BrandCompanyChannel, number>;
  /** A single distinct catalog host, stripping www; conflicting catalog hosts omit the hint. */
  dtcDomain: string | null;
  match: BrandCompanyMatch | null;
}

export interface MatchBrandsResult {
  checked: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  errors: { brandId: string; name: string; error: string }[];
  refreshed?: MatchRefreshResult | undefined;
}

/** A matched brand whose company was merged away or whose website changed. */
export interface MatchChange {
  brandId: string;
  name: string;
  kind: "merged" | "website";
  from: { companyId: string | null; domain: string | null };
  to: { companyId: string | null; domain: string | null };
}

export interface MatchRefreshResult {
  checked: number;
  merged: number;
  website: number;
  unchanged: number;
  changes: MatchChange[];
}

/** A stored match with its brand's name, for the refresh of matched brands. */
export type NamedBrandCompanyMatch = BrandCompanyMatch & { name: string };

/** Keep subdomains (other than www) rather than guessing a public suffix or a parent company. */
export function brandCompanyDomain(value: string | null | undefined): string | null {
  return domainOf(value?.trim())?.replace(/\.$/, "") || null;
}
