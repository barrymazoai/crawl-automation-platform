import { AMAZON_MARKETPLACES, type AmazonChannel } from "@crawl-automation/v3-contracts";

/**
 * KAN-243: what differs between Amazon storefronts. Selectors, galleries, variations, Best Sellers Rank, the sales
 * badge and the verification page are the same on every storefront and stay shared; only these values change.
 */
export interface AmazonSite {
  channel: AmazonChannel;
  origin: string;
  /** Hostnames of this storefront's own product pages. */
  hosts: RegExp;
  currency: string;
  /** The printed price prefixes, in front of the amount ("$", "₹"). */
  pricePrefix: RegExp;
  /** Delivery postal codes printed in the location line ("Delivering to Mumbai 400017"). */
  postalCode: RegExp;
  /** date-fns patterns of "Date First Available", in the storefront's English locale. */
  dateFormats: readonly string[];
  parserVersion: "amazon-rendered/1" | "amazon-in-rendered/1";
  /**
   * KAN-243 (owner 2026-11-07): the longest side, in pixels, gallery images are downloaded at; null keeps the page's own
   * image URLs. Indian labels print small type on a side of the jar: the page's 1500 px image left Man Matters' panel
   * unreadable, and Amazon serves the same image at up to 2560 px (never enlarged past the uploaded original).
   */
  imageSize: number | null;
  /**
   * The order a brand scan reads its seven search pages in. amazon.com: newest first, so a new product is found.
   * amazon.in (owner 2026-11-08): best sellers first. Its brand searches are longer than seven pages and newest first
   * filled them with reseller relistings that print no label (Himalaya: 21 of the first 29 had none).
   */
  scanSort: "date-desc-rank" | "exact-aware-popularity-rank";
  /**
   * How many search pages a brand scan reads, and how many of a page's listed products it keeps (null: all). amazon.in
   * (owner 2026-11-08, demo week): one page, a brand's ten best sellers, so a day's crawl covers many companies; owner
   * 2026-11-09: two pages, so a large brand's catalogue is mostly covered (a brand search page lists 24: 48 kept).
   */
  scanPages: number;
  scanProducts: number | null;
  /**
   * The supplement department node a brand search is scoped to (`i=hpc&rh=n:<node>,p_123:<brand>`): amazon.com's
   * sources use Vitamins, Minerals & Supplements; amazon.in's Diet & Nutrition covers vitamins, sports supplements and
   * family nutrition (without it Himalaya's scan listed face wash and wipes).
   */
  supplementNode: string;
}

export const AMAZON_US: AmazonSite = {
  channel: "amazon",
  origin: AMAZON_MARKETPLACES.amazon.origin,
  hosts: /^(?:(?:www|smile|m)\.)?amazon\.com$/,
  currency: AMAZON_MARKETPLACES.amazon.currency,
  pricePrefix: /(?:\$|USD\s*)/,
  postalCode: /\b\d{5}(?:-\d{4})?\b/g,
  dateFormats: ["MMMM d, yyyy", "MMMM d yyyy"],
  parserVersion: "amazon-rendered/1",
  imageSize: null,
  scanSort: "date-desc-rank",
  scanPages: 7,
  scanProducts: null,
  supplementNode: "3760901",
};

// Real amazon.in pages, 2026-11-04 (docs/plans/KAN-243-india-research.md §4): "₹2,129" in priceToPay's whole part
// (its .a-offscreen is a blank), "Date First Available : 7 August 2012".
export const AMAZON_IN: AmazonSite = {
  channel: "amazon-in",
  origin: AMAZON_MARKETPLACES["amazon-in"].origin,
  hosts: /^(?:(?:www|m)\.)?amazon\.in$/,
  currency: AMAZON_MARKETPLACES["amazon-in"].currency,
  pricePrefix: /(?:₹|INR\s*|Rs\.?\s*)/,
  postalCode: /\b\d{6}\b/g,
  dateFormats: ["d MMMM yyyy"],
  parserVersion: "amazon-in-rendered/1",
  imageSize: 2560,
  scanSort: "exact-aware-popularity-rank",
  scanPages: 2,
  scanProducts: 50,
  supplementNode: "1374489031",
};

export const AMAZON_SITES: Readonly<Record<AmazonChannel, AmazonSite>> = {
  amazon: AMAZON_US,
  "amazon-in": AMAZON_IN,
};
