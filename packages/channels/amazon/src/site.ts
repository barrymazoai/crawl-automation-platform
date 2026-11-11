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
  parserVersion:
    "amazon-rendered/1" | "amazon-in-rendered/1" | "amazon-uk-rendered/1" | "amazon-ca-rendered/1";
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
  /**
   * The search department (`i=`) that node is searched in. amazon.com and amazon.in call it `hpc`; amazon.co.uk
   * (2026-11-10, its Enzymedica page 1) calls it `drugstore` and its next-page links say so even when page 1 was asked
   * with `hpc`, so a source built with `hpc` failed BRAND_SCAN.PAGINATION on every brand with a second page.
   */
  searchAlias: "hpc" | "drugstore";
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
  searchAlias: "hpc",
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
  searchAlias: "hpc",
};

// Real amazon.co.uk pages, 2026-11-10 (docs/plans/KAN-243-uk-plan.md §1): "£9.99" in priceToPay, "Delivering to
// London E177QZ" / "Rickmansw... WD3" (a full postcode or its outward code), no "Date First Available" line at all;
// Health & Personal Care > Vitamins, Minerals & Supplements is node 2826484031. The UK reads India's settings
// otherwise: best sellers first, two search pages per brand, galleries at 2560 px.
export const AMAZON_UK: AmazonSite = {
  channel: "amazon-uk",
  origin: AMAZON_MARKETPLACES["amazon-uk"].origin,
  hosts: /^(?:(?:www|m)\.)?amazon\.co\.uk$/,
  currency: AMAZON_MARKETPLACES["amazon-uk"].currency,
  pricePrefix: /(?:£|GBP\s*)/,
  postalCode: /\b[A-Z]{1,2}\d[A-Z\d]?(?:\s*\d[A-Z]{2})?\b/g,
  dateFormats: ["d MMMM yyyy"],
  parserVersion: "amazon-uk-rendered/1",
  imageSize: 2560,
  scanSort: "exact-aware-popularity-rank",
  scanPages: 2,
  scanProducts: 50,
  supplementNode: "2826484031",
  searchAlias: "drugstore",
};

// Real amazon.ca pages, 2026-11-11 (docs/plans/KAN-243-canada-plan.md §1): "$7.20 with 15 percent savings" (Canadian
// dollars printed with a bare "$"), "Delivering to Montreal H3H" / "Balzac T4B 2T3" (a postal code's first three
// characters or all six), "Date First Available : Jan. 23 2013" / "June 3 2014" (a short month abbreviated with a
// point, no comma), Best Sellers Rank with "#" as on amazon.com. Health & Personal Care > Vitamins, Minerals &
// Supplements is node 6369748011, searched in the `hpc` department (Webber Naturals' page 1 links page 2 with `hpc`).
export const AMAZON_CA: AmazonSite = {
  channel: "amazon-ca",
  origin: AMAZON_MARKETPLACES["amazon-ca"].origin,
  hosts: /^(?:(?:www|m)\.)?amazon\.ca$/,
  currency: AMAZON_MARKETPLACES["amazon-ca"].currency,
  // A bare "$" is Canadian; "US$" (a price in another currency) is never read as one.
  pricePrefix: /(?:C\$|CA\$|CAD\s*|(?<![A-Za-z])\$)/,
  // Any case: amazon.ca also prints "Delivering to Montreal h1a" (B00L3WS0Y2, 2026-11-11).
  postalCode: /\b[A-Z]\d[A-Z](?:\s*\d[A-Z]\d)?\b/gi,
  dateFormats: ["MMM. d yyyy", "MMMM d yyyy"],
  parserVersion: "amazon-ca-rendered/1",
  imageSize: 2560,
  scanSort: "exact-aware-popularity-rank",
  scanPages: 2,
  scanProducts: 50,
  supplementNode: "6369748011",
  searchAlias: "hpc",
};

export const AMAZON_SITES: Readonly<Record<AmazonChannel, AmazonSite>> = {
  amazon: AMAZON_US,
  "amazon-in": AMAZON_IN,
  "amazon-uk": AMAZON_UK,
  "amazon-ca": AMAZON_CA,
};
