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
} as const;

export type AmazonChannel = keyof typeof AMAZON_MARKETPLACES;
export type AmazonMarketplace = (typeof AMAZON_MARKETPLACES)[AmazonChannel]["marketplace"];
export const AMAZON_CHANNELS = Object.keys(AMAZON_MARKETPLACES) as AmazonChannel[];

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
