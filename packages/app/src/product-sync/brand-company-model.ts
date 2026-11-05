import { z } from "zod";
import { domainOf } from "../brand-enrichment/run-records.js";

export const BRAND_COMPANY_CANDIDATE_LIMIT = 20;
export const BRAND_COMPANY_RECHECK_MS = 24 * 60 * 60 * 1000;
export const BrandCompanyStatusSchema = z.enum(["matched", "unmatched", "ambiguous"]);
export type BrandCompanyStatus = z.infer<typeof BrandCompanyStatusSchema>;
export type BrandCompanyChannel = "amazon" | "gnc" | "swanson" | "wholefoods" | "costco";

export const MatchBrandsSchema = z.object({
  limit: z.number().int().min(1).max(500),
  recheckUnmatched: z.boolean().optional(),
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
}

/** Keep subdomains (other than www) rather than guessing a public suffix or a parent company. */
export function brandCompanyDomain(value: string | null | undefined): string | null {
  return domainOf(value?.trim())?.replace(/\.$/, "") || null;
}
