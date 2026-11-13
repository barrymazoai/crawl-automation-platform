import type { LabelFormatId } from "./label-formats.js";
import { MARKETPLACE_LABEL_FORMATS } from "./label-formats.js";

/**
 * KAN-243 (owner 2026-11-05): one crawler channel per Amazon storefront. An ASIN repeats across storefronts, so the
 * storefront is part of a listing's identity through its channel (`amazon` = amazon.com, `amazon-in` = amazon.in);
 * every table keyed by channel keeps the US rows exactly as they were. The marketplace name is what Supply Smart
 * receives; it must be on Supply Smart's own allow list (`lib/marketplace.ts`) before a storefront is added here.
 */
export const AMAZON_MARKETPLACES = {
  amazon: {
    marketplace: "amazon.com",
    origin: "https://www.amazon.com",
    countryCode: "US",
    currency: "USD",
  },
  "amazon-in": {
    marketplace: "amazon.in",
    origin: "https://www.amazon.in",
    countryCode: "IN",
    currency: "INR",
  },
  // KAN-243 (owner 2026-11-10): the UK, the easiest storefront after the delivery-location test (26 of 26 pages
  // delivered in the UK through ScraperAPI, English pages). Supply Smart's allow list has amazon.co.uk.
  "amazon-uk": {
    marketplace: "amazon.co.uk",
    origin: "https://www.amazon.co.uk",
    countryCode: "GB",
    currency: "GBP",
  },
  // KAN-243 (owner 2026-11-11): Canada, after the UK (21 of 21 pages delivered in Canada through ScraperAPI, en-ca
  // pages, docs/plans/KAN-243-canada-plan.md). Supply Smart's allow list has amazon.ca.
  "amazon-ca": {
    marketplace: "amazon.ca",
    origin: "https://www.amazon.ca",
    countryCode: "CA",
    currency: "CAD",
  },
  // KAN-243 (owner 2026-11-11): Germany, the first of the EU storefronts Robert named (26 of 26 pages delivered in
  // Germany through ScraperAPI; English pages with ?language=en_GB, docs/plans/KAN-243-germany-plan.md). Supply Smart's
  // allow list has amazon.de.
  "amazon-de": {
    marketplace: "amazon.de",
    origin: "https://www.amazon.de",
    countryCode: "DE",
    currency: "EUR",
  },
  // KAN-243 (owner 2026-11-13): Spain, after Germany (22 of 23 pages delivered in Spain through ScraperAPI; English pages
  // with ?language=en_GB, docs/plans/KAN-243-spain-plan.md). amazon.fr was passed over: it has no English pages.
  // Supply Smart's allow list has amazon.es.
  "amazon-es": {
    marketplace: "amazon.es",
    origin: "https://www.amazon.es",
    countryCode: "ES",
    currency: "EUR",
  },
} as const;

export type AmazonChannel = keyof typeof AMAZON_MARKETPLACES;
export type AmazonMarketplace = (typeof AMAZON_MARKETPLACES)[AmazonChannel]["marketplace"];
/** The storefronts other than amazon.com: their listings name a marketplace and are sent to their own target. */
export const FOREIGN_AMAZON_CHANNELS = [
  "amazon-in",
  "amazon-uk",
  "amazon-ca",
  "amazon-de",
  "amazon-es",
] as const;
export type ForeignAmazonChannel = (typeof FOREIGN_AMAZON_CHANNELS)[number];
/** Every Amazon storefront channel, amazon.com first: the one list other channel lists are built from. */
export const AMAZON_CHANNELS = ["amazon", ...FOREIGN_AMAZON_CHANNELS] as const;
// The list and the table name the same storefronts (a compile error names a missing one).
const listed: [Exclude<AmazonChannel, (typeof AMAZON_CHANNELS)[number]>, Exclude<(typeof AMAZON_CHANNELS)[number], AmazonChannel>] extends [never, never] ? true : never = true;
void listed;

/** Whether a channel is one of the Amazon storefronts (same pages, same ASINs, different site). */
export function isAmazonChannel(channel: string): channel is AmazonChannel {
  return Object.hasOwn(AMAZON_MARKETPLACES, channel);
}

/** The marketplace a channel's listings are sold on, or null for a channel that is not an Amazon storefront. */
export function amazonMarketplaceOf(channel: string): AmazonMarketplace | null {
  return isAmazonChannel(channel) ? AMAZON_MARKETPLACES[channel].marketplace : null;
}

/** Supply Smart's channel for a crawler channel: every Amazon storefront is Supply Smart's `amazon`. */
export function supplySmartChannel<C extends string>(
  channel: C,
): Exclude<C, AmazonChannel> | "amazon" {
  return isAmazonChannel(channel) ? "amazon" : (channel as Exclude<C, AmazonChannel>);
}

/**
 * The `marketplace` a delivery names for a crawler channel: another storefront than amazon.com, or undefined.
 * amazon.com stays implicit (Supply Smart reads a request without one as amazon.com), so every US request body is
 * byte-identical to before.
 */
export function deliveredMarketplace(channel: string): AmazonMarketplace | undefined {
  return isAmazonChannel(channel) && channel !== "amazon"
    ? AMAZON_MARKETPLACES[channel].marketplace
    : undefined;
}

/** The label formats an Amazon storefront's labels are read in. */
export function amazonLabelFormats(channel: AmazonChannel): readonly LabelFormatId[] {
  const formats = MARKETPLACE_LABEL_FORMATS[AMAZON_MARKETPLACES[channel].marketplace];
  if (!formats) {
    throw new Error(`no label formats for ${channel}`);
  }
  return formats;
}

/**
 * KAN-243 (owner 2026-11-11, Germany plan option A): the language a storefront's labels are copied in when it is not
 * English. The copy keeps the printed words; what Supply Smart receives is translated into English first (Robert: "我们
 * 平台用户都是英语用户"). Absent: the labels are English (or copied in English only, as Canada's).
 */
const LABEL_LANGUAGES: Partial<Record<AmazonChannel, "de">> = {
  "amazon-de": "de",
  // amazon.es (2026-11-13): our brands' Spanish listings carry the same EU multilingual stickers, copied from their
  // English (UK) section or else their German (DE) one, never the Spanish.
  "amazon-es": "de",
};

/** The language a channel's labels are printed in, or null for English. */
export function labelLanguageOf(channel: string): "de" | null {
  return isAmazonChannel(channel) ? (LABEL_LANGUAGES[channel] ?? null) : null;
}
